/**
 * pi-memory — Claude Code-style auto memory for pi.
 *
 * Ported from a reverse-engineering analysis of Claude Code v2.1.252's memory
 * system (see claude-analysis/report/). Subsystems included:
 *
 *  - `# Memory` system prompt section with the MEMORY.md index (200-line /
 *    25KB truncation warnings, verbatim from Claude Code), snapshotted once
 *    per session like Claude Code (mid-session updates reach the model via
 *    recall messages and tool results, so the prompt-cache prefix stays valid)
 *  - Pinned memories (up to 4) injected at session start
 *  - Recall injection as a <system-reminder> message with per-memory age
 *    disclaimers, session dedupe, and a session byte budget
 *  - memory_save tool (one-shot save + index update with validation, routed
 *    through pi's withFileMutationQueue so parallel tool calls can't race on
 *    the index)
 *  - Provenance stamping on file-tool writes into the memory directory
 *  - Background extraction after the agent settles (gated, single structured
 *    model call over pi's serializeConversation transcript, id cursor like
 *    Claude Code's last-extracted message uuid, ops applied through
 *    extension-side validation)
 *  - `#` memory shortcut (input transform), /memory panel, /pause-memory
 *    session toggle, /memory-extract, /remember (promote to team), /dream
 *
 * @module pi-memory
 */

import { StringEnum, uuidv7 } from "@earendil-works/pi-ai";
import {
	convertToLlm,
	getAgentDir,
	serializeConversation,
	withFileMutationQueue,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { join as pathJoin } from "node:path";
import { Type } from "typebox";
import {
	LIMITS,
	loadConfig,
	resolvePaths,
	type MemoryConfig,
	type MemoryPaths,
} from "./config.js";
import { serializeMemory, slugName, stampProvenance } from "./frontmatter.js";
import {
	applyExtractOps,
	buildDreamPrompt,
	buildExtractionPrompt,
	checkExtractionGates,
	collectEntriesSince,
	containsSecret,
	flattenIndexLine,
	isDreamPrompt,
	normalizeContent,
	parseExtractResponse,
} from "./extract.js";
import { buildIndexSection, buildMemoryPromptSection, buildPinnedSection } from "./prompt.js";
import { RecallSession, recallForPrompt } from "./recall.js";
import {
	ensureDirs,
	deleteFileSafe,
	formatIndexLine,
	indexPath,
	listMemories,
	readFileOrNull,
	readIndex,
	removeIndexLine,
	upsertIndexLine,
	writeFileSafe,
} from "./store.js";

const PAUSED_MESSAGE = "Memory is paused. Run /pause-memory to resume automemory.";
// Pause gates every tool that touches memory-dir files. Claude Code denies
// memory-dir Read AND Write while paused ("will not write or read new memories").
const MEMORY_TOOLS = new Set(["read", "write", "edit", "memory_save"]);
const TRANSCRIPT_MAX_CHARS = 24_000;
// Minimal observability, mirroring Claude Code's n() debug logging for memory.
const DEBUG = Boolean(process.env.PI_MEMORY_DEBUG?.trim());
function debug(message: string, ...rest: unknown[]) {
	if (DEBUG) console.error("[pi-memory]", message, ...rest);
}

/** Minimal structural view of ExtensionContext used by the extraction flow. */
interface RunCtx {
	model?: unknown;
	modelRegistry: {
		complete: (
			model: unknown,
			params: unknown,
			opts: Record<string, unknown>,
		) => Promise<{ content: Array<{ type: string; text?: string }> }>;
	};
	signal?: AbortSignal | undefined;
	sessionManager: {
		getBranch: () => unknown[];
		getEntries: () => unknown[];
		buildContextEntries?: () => unknown[];
	};
	ui?: { setStatus?: (key: string, value: string) => void };
}

interface EntryLike {
	type?: string;
	id?: string;
	customType?: string;
	data?: Record<string, unknown>;
	message?: { role?: string; content?: unknown };
}

export default function piMemoryExtension(pi: ExtensionAPI) {
	// Single-instance guard: installing the extension globally AND in a project
	// would otherwise double-inject the memory prompt (pi suffixes colliding
	// command names but runs every event handler). The flag is released on
	// session_shutdown so /reload rebinding still works.
	const guardKey = "__piMemoryLoaded";
	if ((globalThis as Record<string, unknown>)[guardKey] === true) {
		console.error("[pi-memory] another instance is already loaded (global + project copy?) — this instance stays inert.");
		return;
	}
	(globalThis as Record<string, unknown>)[guardKey] = true;
	pi.on("session_shutdown", async () => {
		delete (globalThis as Record<string, unknown>)[guardKey];
	});

	const cwd = process.cwd();
	const config: MemoryConfig = loadConfig(cwd);
	let paths: MemoryPaths = resolvePaths(cwd, config);

	let paused = false;
	let enabled = true;
	/** Session-stable memory prompt snapshot (Claude Code builds it once per session). */
	let memoryPromptSnapshot = "";
	const recallSession = new RecallSession();
	/** Id of the last message entry covered by an extraction (Claude Code's `r` uuid). */
	let lastExtractedId: string | null = null;
	let directWriteSinceExtract = false;
	let sessionId = uuidv7();

	const setStatus = (ctx: unknown, text: string) => {
		(ctx as RunCtx | null | undefined)?.ui?.setStatus?.("pi-memory", text);
	};

	const statusText = () => {
		const files = listMemories(paths).length;
		return `memory: ${files} file${files === 1 ? "" : "s"}${paused ? " · paused" : ""}`;
	};

	/**
	 * Claude Code assembles the # Memory section (types, discipline, index
	 * content, pinned memories) once per session; mid-session index edits are
	 * NOT reflected into the system prompt (that would invalidate the provider
	 * prompt-cache prefix). Freshness comes from recall messages instead.
	 */
	const snapshotMemoryPrompt = () => {
		let snapshot = buildMemoryPromptSection(paths, config.citeMemories);
		snapshot += "\n\n" + buildIndexSection(readIndex(paths).content);
		const pinned = buildPinnedSection(listMemories(paths), (abs) => readFileOrNull(abs));
		if (pinned) snapshot += "\n\n" + pinned;
		memoryPromptSnapshot = snapshot;
	};

	/** Active branch with compaction applied — what the model actually sees. */
	const activeEntries = (ctx: RunCtx): unknown[] =>
		ctx.sessionManager.buildContextEntries?.() ?? ctx.sessionManager.getBranch();

	/** pi's own compaction-style transcript for the extraction model call. */
	const renderTranscript = (messages: unknown[]): string => {
		const serialized = serializeConversation(convertToLlm(messages as never[]));
		if (serialized.length <= TRANSCRIPT_MAX_CHARS) return serialized;
		return serialized.slice(serialized.length - TRANSCRIPT_MAX_CHARS);
	};

	/** Run the gated extraction flow; returns a human-readable result line. */
	const runExtraction = async (ctx: RunCtx, force: boolean): Promise<string> => {
		if (paused && !force) return PAUSED_MESSAGE;
		const branch = activeEntries(ctx) as EntryLike[];
		const { views, lastEntryId } = collectEntriesSince(branch, lastExtractedId);
		const recent = views.length > 0 ? views : force ? collectEntriesSince(branch, null).views.slice(-10) : [];
		if (recent.length === 0 && !force) return "skipped: no new messages since the last extraction";

		const gate = force
			? { run: true as const, reason: "forced", newMessageCount: recent.length, advanceCursor: true }
			: checkExtractionGates(recent, config.autoExtractMinMessages, directWriteSinceExtract);
		if (!gate.run) {
			debug("extraction gate:", gate.reason);
			// $ln skip paths consume the messages — advance the persisted cursor so
			// the covered messages are never re-extracted.
			if (gate.advanceCursor && lastEntryId && lastEntryId !== lastExtractedId) {
				lastExtractedId = lastEntryId;
				pi.appendEntry("pi-memory:extraction-cursor", { lastExtractedId });
			}
			return `skipped: ${gate.reason}`;
		}

		const prompt = buildExtractionPrompt(paths, renderTranscript(recent.map((view) => view.message)), recent.length);
		const model = ctx.model;
		if (!model) return "no active model";
		setStatus(ctx, "memory: extracting…");
		try {
			const response = await ctx.modelRegistry.complete(
				model,
				{
					messages: [
						{
							role: "user" as const,
							content: [{ type: "text" as const, text: prompt }],
							timestamp: Date.now(),
						},
					],
				},
				{ maxTokens: 4096, signal: ctx.signal, cacheRetention: "none", sessionId: uuidv7() },
			);
			const text = response.content
				.filter((block) => block.type === "text")
				.map((block) => block.text ?? "")
				.join("\n");
			const parsed = parseExtractResponse(text);
			if (!parsed) return "extraction produced no parsable ops";
			const result = await withFileMutationQueue(indexPath(paths), async () =>
				applyExtractOps(paths, parsed.ops, sessionId, listMemories(paths).filter((m) => m.pinned).length),
			);
			lastExtractedId = lastEntryId ?? lastExtractedId;
			directWriteSinceExtract = false;
			pi.appendEntry("pi-memory:extracted", { lastExtractedId, written: result.written });
			if (result.applied === 0) {
				return `nothing saved${result.skipped.length ? ` (${result.skipped[0]})` : ""}`;
			}
			return (
				`saved ${result.applied} memor${result.applied === 1 ? "y" : "ies"}: ${result.written.join(", ")}` +
				(result.skipped.length ? `; skipped ${result.skipped.length}: ${result.skipped.join("; ")}` : "")
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return `extraction failed: ${message}`;
		} finally {
			setStatus(ctx, statusText());
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		Object.assign(config, loadConfig(cwd));
		paths = resolvePaths(cwd, config);
		ensureDirs(paths);
		recallSession.reset();
		paused = false;
		lastExtractedId = null;
		directWriteSinceExtract = false;
		try {
			const id = (ctx.sessionManager as unknown as { getSessionId?: () => string }).getSessionId?.();
			if (id) sessionId = id;
		} catch {
			// keep the generated id
		}
		// Restore the extraction cursor, recall state, and the paused flag from
		// persisted custom entries (Claude Code persists pause via session
		// internal metadata — this is the pi equivalent).
		for (const entry of ctx.sessionManager.getEntries() as EntryLike[]) {
			if (entry?.type !== "custom") continue;
			if (entry.customType === "pi-memory:extracted") {
				const cursor = entry.data?.lastExtractedId;
				if (typeof cursor === "string") lastExtractedId = cursor;
			}
			if (entry.customType === "pi-memory:state" && typeof entry.data?.paused === "boolean") {
				// Entries iterate in write order, so the LAST state entry wins
				// (on→off must restore as off, not stay on).
				paused = entry.data.paused;
			}
		}
		snapshotMemoryPrompt();
		debug("session_start: snapshot chars:", memoryPromptSnapshot.length, "cursor:", lastExtractedId);
		setStatus(ctx, statusText());
		// R29: nudge toward a dream when Claude Code's auto-dream conditions
		// hold (>= 24h since the last dream and >= 5 sessions) — as a notice,
		// not an ambient task.
		void maybeNudgeDream(ctx);
	});
	// Session names changed after the last dream — iEt's "Sessions since last
	// consolidation" list (m0354:107132).
	const dreamSessionList = async (): Promise<string[]> => {
		try {
			const { SessionManager } = await import("@earendil-works/pi-coding-agent");
			const sessions = await SessionManager.list(cwd);
			const since = dreamTimestamp();
			return sessions
				.filter((s) => s.modified.getTime() > since)
				.sort((a, b) => a.modified.getTime() - b.modified.getTime())
				.map((s) => s.name ?? ((s.firstMessage || "").slice(0, 80) || s.id));
		} catch {
			return [];
		}
	};

	const maybeNudgeDream = async (ctx: unknown) => {
		try {
			const { SessionManager } = await import("@earendil-works/pi-coding-agent");
			const sessions = await SessionManager.list(cwd);
			const lastDream = dreamTimestamp();
			if (sessions.length >= 5 && Date.now() - lastDream > 24 * 3600_000) {
				(ctx as RunCtx | null | undefined)?.ui?.setStatus?.("pi-memory", "memory: due for /dream");
				debug("dream nudge: sessions", sessions.length, "last dream", new Date(lastDream).toISOString());
			}
		} catch (error) {
			debug("dream nudge skipped:", error instanceof Error ? error.message : String(error));
		}
	};

	const dreamTimestamp = (): number => {
		// Best effort: mtime of the most recently modified memory file; a
		// directory that has not changed in a day is due for consolidation.
		const memories = listMemories(paths);
		return memories.length > 0 ? Math.max(...memories.map((m) => m.mtimeMs)) : 0;
	};

	pi.on("before_agent_start", async (event, ctx) => {
		if (!enabled) return;
		setStatus(ctx, statusText());

		if (config.recall && !paused && event.prompt.trim()) {
			const result = recallForPrompt(paths, event.prompt, recallSession, config.citeMemories);
			if (result.reminder) {
				recallSession.mark(result.refs, result.bytes);
				return {
					systemPrompt: event.systemPrompt + (memoryPromptSnapshot ? "\n\n" + memoryPromptSnapshot : ""),
					message: {
						customType: "pi-memory:recall",
						content: result.reminder,
						display: false,
					},
				};
			}
		}
		return {
			systemPrompt: event.systemPrompt + (memoryPromptSnapshot ? "\n\n" + memoryPromptSnapshot : ""),
		};
	});

	// Claude Code's `#` memory shortcut (u$t): a first line that is only "# …"
	// (no prose after it on later lines) is an explicit remember-this request.
	pi.on("input", async (event, ctx) => {
		if (!enabled) return { action: "continue" };
		if (event.source !== "interactive") return { action: "continue" };
		const { text } = event;
		// u$t(): the trimmed first line is only "# …", later lines carry no
		// prose (empty or # lines only), and the content has no control chars.
		const firstLineEnd = text.indexOf("\n");
		const firstLine = (firstLineEnd === -1 ? text : text.slice(0, firstLineEnd)).trim();
		if (!firstLine.startsWith("#") || firstLine.startsWith("#!")) return { action: "continue" };
		const rest = firstLineEnd === -1 ? "" : text.slice(firstLineEnd + 1);
		if (firstLineEnd !== -1 && restHasProse(rest)) return { action: "continue" };
		const content = firstLine.replace(/^#+\s*/, "").trim();
		if (!content || hasControlChars(content)) return { action: "continue" };
		if (paused) {
			// Don't pass the bare "# …" line through to the model; tell the user why.
			ctx.ui.notify(PAUSED_MESSAGE, "warning");
			return { action: "handled" };
		}
		return {
			action: "transform",
			text:
				`[Memory shortcut] The user typed "# ${content}" — an explicit request to remember this for future sessions. ` +
				`Save it now with the memory_save tool (pick the fitting type; it updates the MEMORY.md index for you), ` +
				`then reply with one short confirmation line.`,
		};
	});

	// Pause denials use CC's per-direction messages: Si (write, m0169:8592) and
	// c6's read deny (m0169:9674) — reads of memory files are blocked too.
	const PAUSED_WRITE_MESSAGE = "Cannot write to memory while it is paused. Run /pause-memory to resume automemory.";
	const PAUSED_READ_MESSAGE = "Cannot read memory while it is paused. Run /pause-memory to resume automemory.";

	pi.on("tool_call", async (event) => {
		if (!enabled) return;
		if (!MEMORY_TOOLS.has(event.toolName)) return;
		if (event.toolName === "memory_save") {
			if (paused) return { block: true, reason: PAUSED_WRITE_MESSAGE };
			return;
		}
		const target = (event.input as { path?: unknown } | undefined)?.path;
		if (typeof target !== "string") return;
		if (!isInsideMemory(target, paths)) return;
		if (paused) {
			return { block: true, reason: event.toolName === "read" ? PAUSED_READ_MESSAGE : PAUSED_WRITE_MESSAGE };
		}
	});

	pi.on("tool_result", async (event) => {
		if (!enabled) return;
		if (event.toolName !== "write" && event.toolName !== "edit") return;
		const target = (event.input as { path?: unknown } | undefined)?.path;
		if (typeof target !== "string" || !isInsideMemory(target, paths)) return;
		// rUn counts any Write/Edit inside the memory dir as a direct write
		// (no extension filter); HD's stamp itself only touches .md files.
		directWriteSinceExtract = true;
		if (!target.endsWith(".md")) return;
		// Stamp provenance the way Claude Code's stampNewMemoryContent does:
		// add originSessionId/modified when missing, refresh modified otherwise.
		// Routed through the same mutation queue as memory_save so a parallel
		// save of the same file cannot interleave with the stamp write.
		await withFileMutationQueue(indexPath(paths), async () => {
			const raw = readFileOrNull(target);
			if (raw !== null) {
				const stamped = stampProvenance(raw, sessionId);
				if (stamped !== raw) {
					writeFileSafe(target, stamped);
					debug("stamped provenance:", target);
				}
			}
		});
	});

	// Claude Code coalesces overlapping extractor runs into one trailing run
	// (tengu_extract_memories_coalesced); pi can fire agent_settled while an
	// extraction still awaits the model, so mirror that here.
	let extractionInFlight = false;
	let extractionPending = false;
	pi.on("agent_settled", async (_event, ctx) => {
		if (!enabled || !config.autoExtract || paused) return;
		if (extractionInFlight) {
			extractionPending = true;
			return;
		}
		extractionInFlight = true;
		let result: string;
		try {
			result = await runExtraction(ctx as unknown as RunCtx, false);
		} finally {
			extractionInFlight = false;
		}
		if (extractionPending) {
			extractionPending = false;
			result = await runExtraction(ctx as unknown as RunCtx, false);
		}
		// Surface the outcome (or the skip reason) so a silent no-op is never
		// mistaken for a completed extraction.
		if (ctx.hasUI && !result.startsWith("skipped: no new messages")) {
			ctx.ui.notify(`pi-memory: ${result}`, "info");
		}
	});

	// TUI feedback line for persisted extraction entries (Claude Code shows
	// "saved N memories" in the collapsed transcript rows).
	pi.registerEntryRenderer("pi-memory:extracted", (entry, _options, theme) => {
		const data = entry.data as { written?: string[] } | undefined;
		const line = data?.written?.length
			? `memory: saved ${data.written.join(", ")}`
			: "memory: extraction ran";
		return new Text(theme.fg("dim", line), 0, 0);
	});

	pi.registerTool({
		name: "memory_save",
		label: "Save memory",
		description:
			"Save a memory file to your persistent memory directory and update the MEMORY.md index in one call. " +
			"Use for user facts (type user), corrections/confirmed approaches (feedback), non-derivable project context (project), " +
			"and external-resource pointers (reference). One fact per file; the body REPLACES the whole file (under 4096 bytes — " +
			"split or summarize if longer); line endings are normalized to LF and control characters are stripped; never save secrets.",
		promptSnippet: "Save a memory file and update the MEMORY.md index in one call",
		promptGuidelines: [
			"Use memory_save when the user's latest message teaches a durable, applicable lesson (a correction or standing preference) — save it in that same reply, before treating the turn as finished.",
			"Do not save code structure, git history, fix recipes, AGENTS.md content, or ephemeral task state with memory_save.",
		],
		parameters: Type.Object({
			name: Type.String({ description: "Short kebab-case slug, also the filename (e.g. feedback-terse-replies)" }),
			type: StringEnum(["user", "feedback", "project", "reference"] as const, {
				description:
					"user: who the user is; feedback: guidance on how to work (with the why); project: non-derivable ongoing work/decisions (absolute dates); reference: external-resource pointers",
			}),
			description: Type.String({
				description: "One-line summary used to decide relevance in future conversations — be specific",
			}),
			body: Type.String({
				description:
					"The fact. For feedback/project follow with **Why:** and **How to apply:** lines. Link related memories with [[their-name]]. Under 4096 bytes.",
			}),
			pinned: Type.Optional(
				Type.Boolean({ description: "true only if this must apply to EVERY future session (max 4 pinned)" }),
			),
			indexLine: Type.Optional(
				Type.String({ description: "Optional custom index line: - [Title](file.md) — one-line hook" }),
			),
			team: Type.Optional(
				Type.Boolean({
					description: "Save to the shared project memory (team/) instead of the private directory; requires shared memory enabled",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!enabled) return toolError("pi-memory is disabled for this session (toggle it in /memory).");
			if (paused) return toolError(PAUSED_MESSAGE);
			// A name carrying path structure is a traversal attempt, not a slug:
			// refuse it outright instead of silently rewriting it (Claude Code's
			// memory tools reject malformed paths rather than normalizing them).
			if (/[\\/]|(^|[^a-z0-9])\.\./i.test(params.name)) {
				return toolError("name must be a short slug without path separators or '..'");
			}
			if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(params.name.trim())) {
				return toolError("name collides with a reserved Windows device name");
			}
			// m0169 ps(): conforming [a-z0-9_-] names pass through (ds);
			// anything else is lowercased and hyphen-slugified.
			const name = slugName(params.name.trim());
			if (!name) return toolError("name must contain alphanumeric characters");
			const file = `${name}.md`;
			const team = params.team === true;
			if (team && !paths.teamDir) return toolError("shared (team) memory is not enabled for this project");
			// Claude Code's memory_write normalizes content before it hits disk
			// (qF): LF line endings, control/format characters to U+FFFD.
			const description = normalizeContent(params.description).trim();
			const body = normalizeContent(params.body).trimEnd();
			if (Buffer.byteLength(body, "utf-8") > LIMITS.fileMaxBytes) {
				return toolError(`body exceeds ${LIMITS.fileMaxBytes} bytes — split or summarize the memory`);
			}
			if (containsSecret(`${file}\n${description}\n${body}`)) {
				return toolError("content contains potential secrets and cannot be written to memory");
			}
			if (params.pinned) {
				// Re-saving an already-pinned file must not trip the limit —
				// only a net-new pinned memory counts against the cap.
				const pinnedCount = listMemories(paths).filter((m) => m.pinned && m.ref !== (team ? `team/${file}` : file)).length;
				if (pinnedCount >= LIMITS.maxPinned) {
					return toolError(`pinned memory limit (${LIMITS.maxPinned}) reached — unpin one first`);
				}
			}
			const ref = team ? `team/${file}` : file;
			const abs = team ? `${paths.teamDir}/${file}` : `${paths.personalDir}/${file}`;
			const content = serializeMemory(
				{ name, description, type: params.type, pinned: params.pinned === true, originSessionId: sessionId, modified: new Date().toISOString() },
				body,
			);
			// Serialize memory writes through pi's per-file mutation queue: the
			// memory file and the shared MEMORY.md index must not interleave
			// with parallel write/edit calls in the same assistant turn.
			const saved = await withFileMutationQueue(indexPath(paths), async () => {
				const existedBefore = readFileOrNull(abs) !== null;
				writeFileSafe(abs, content);
				const indexLine = params.indexLine?.trim()
					? flattenIndexLine(normalizeContent(params.indexLine))
					: formatIndexLine(ref, name, description);
				const indexResult = upsertIndexLine(paths, ref, indexLine);
				if (!indexResult.ok) {
					// Roll back a first-time write so no orphan memory lingers outside the index.
					if (!existedBefore) deleteFileSafe(abs);
					return { ok: false as const, error: indexResult.error };
				}
				return { ok: true as const };
			});
			if (!saved.ok) return toolError(saved.error ?? "index update failed");
			directWriteSinceExtract = true;
			setStatus(ctx, statusText());
			return {
				content: [
					{
						type: "text" as const,
						text: `Saved memory ${ref} (${params.type}${params.pinned ? ", pinned" : ""}) and updated MEMORY.md.`,
					},
				],
				details: { ref, type: params.type },
			};
		},
	});

	pi.registerCommand("memory", {
		description: "Open the pi-memory panel (stats, pause, extract, dream)",
		handler: async (_args, ctx) => {
			const memories = listMemories(paths);
			const index = readIndex(paths);
			const summary = [
				`Memory dir: ${paths.personalDir}`,
				paths.teamDir ? `Team dir:   ${paths.teamDir}` : null,
				`Memories:   ${memories.length} file(s), ${memories.filter((m) => m.pinned).length} pinned`,
				`Index:      ${index.lineCount} line(s) → ${indexPath(paths)}`,
				`Auto-extract: ${config.autoExtract ? "on" : "off"} · Recall: ${config.recall ? "on" : "off"} · Paused: ${paused ? "yes" : "no"}`,
			]
				.filter(Boolean)
				.join("\n");
			if (!ctx.hasUI) {
				ctx.ui.notify(summary, "info");
				return;
			}
		// CC /memory (m1646): "Open auto-memory folder" + "Open team memory folder"
		// when team memory is on; org-store and CLAUDE.md rows are documented
		// omissions (pi loads AGENTS.md natively, no enterprise stores).
		const items = [
			`Toggle pause (${paused ? "resume" : "pause"} memory for this session)`,
			"Extract memories from this session now",
			"Run a dream (memory consolidation)",
			"Toggle background auto-extract",
			`Turn pi-memory ${enabled ? "off" : "on"} for this session`,
			"Open memory folder",
			...(paths.teamDir ? ["Open team memory folder"] : []),
			"Close",
		];
		const choice = await ctx.ui.select("pi-memory", items);
			switch (choice) {
				case `Toggle pause (${paused ? "resume" : "pause"} memory for this session)`:
					paused = !paused;
					ctx.ui.notify(
						paused
							? PAUSED_MESSAGE
							: "Memory resumed · memory content may be referenced and new memories can be saved.",
						"info",
					);
					break;
				case "Extract memories from this session now":
					ctx.ui.notify(await runExtraction(ctx as unknown as RunCtx, true), "info");
					break;
				case "Run a dream (memory consolidation)":
					pi.sendUserMessage(buildDreamPrompt(paths, pathJoin(getAgentDir(), "sessions"), await dreamSessionList()));
					break;
				case "Toggle background auto-extract":
					config.autoExtract = !config.autoExtract;
					ctx.ui.notify(`Background auto-extract ${config.autoExtract ? "enabled" : "disabled"}.`, "info");
					break;
				case `Turn pi-memory ${enabled ? "off" : "on"} for this session`:
					enabled = !enabled;
					// Drop memory_save from the active tool set when disabled so
					// the model never sees it (execute() still guards as backup).
					{
						const active = pi.getActiveTools();
						pi.setActiveTools(
							enabled
								? [...new Set([...active, "memory_save"])]
								: active.filter((name) => name !== "memory_save"),
						);
					}
					ctx.ui.notify(
						`pi-memory ${enabled ? "enabled" : "disabled"} for this session` +
							(enabled ? "." : " (fully inert: no prompt, no recall, no extraction, no gating)."),
						"info",
					);
					break;
				case "Open memory folder":
					await openFolder(pi, ctx, paths.personalDir);
					break;
				case "Open team memory folder":
					if (paths.teamDir) await openFolder(pi, ctx, paths.teamDir);
					break;
				default:
					break;
			}
			setStatus(ctx, statusText());
		},
	});

	pi.registerCommand("pause-memory", {
		description: "Pause automemory for this session",
		handler: async (_args, ctx) => {
			paused = !paused;
			pi.appendEntry("pi-memory:state", { paused });
			ctx.ui.notify(
				paused
					? "Memory paused for this session · this conversation will not write or read new memories, and previously-loaded memory content should not be referenced.\n\nRun /pause-memory again to resume."
					: "Memory resumed · memory content may be referenced and new memories can be saved.",
				"info",
			);
			setStatus(ctx, statusText());
		},
	});

	pi.registerCommand("memory-extract", {
		description: "Extract memories from this session now",
		handler: async (_args, ctx) => {
			ctx.ui.notify(await runExtraction(ctx as unknown as RunCtx, true), "info");
		},
	});

	// Claude Code's /remember: the deliberate user-driven promotion of a
	// personal memory into team memory (the dream prompt explicitly defers to it).
	pi.registerCommand("remember", {
		description: "Promote a personal memory to shared team memory (/remember <file.md>)",
		getArgumentCompletions: (prefix: string) => {
			const items = listMemories(paths)
				.filter((m) => !m.ref.startsWith("team/"))
				.map((m) => ({ value: m.ref, label: m.ref, description: m.description }));
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			if (!paths.teamDir) {
				ctx.ui.notify("Shared (team) memory is not enabled — set sharedMemory: true in .pi/memory.json first.", "warning");
				return;
			}
			const ref = args.trim().replace(/^team\//, "");
			if (!/^[a-z0-9][a-z0-9_-]*\.md$/.test(ref)) {
				ctx.ui.notify("Usage: /remember <file.md> (a personal memory filename)", "warning");
				return;
			}
			const source = `${paths.personalDir}/${ref}`;
			const raw = readFileOrNull(source);
			if (raw === null) {
				ctx.ui.notify(`No personal memory named ${ref}.`, "warning");
				return;
			}
			await withFileMutationQueue(indexPath(paths), async () => {
				writeFileSafe(`${paths.teamDir}/${ref}`, raw);
				deleteFileSafe(source);
				// Drop the personal index line too — upserting the team/ line
				// targets a different ref and would leave a stale pointer.
				removeIndexLine(paths, ref);
				const memory = listMemories(paths).find((m) => m.ref === `team/${ref}`);
				upsertIndexLine(paths, `team/${ref}`, formatIndexLine(`team/${ref}`, memory?.name ?? ref.replace(/\.md$/, ""), memory?.description ?? ""));
			});
			ctx.ui.notify(`Promoted ${ref} to team memory (team/${ref}).`, "info");
		},
	});

	pi.registerCommand("dream", {
		description: "Run a memory-consolidation dream over your memory files",
		handler: async (_args, ctx) => {
			if (paused) {
				ctx.ui.notify(PAUSED_MESSAGE, "warning");
				return;
			}
			await ctx.waitForIdle();
			pi.sendUserMessage(buildDreamPrompt(paths, pathJoin(getAgentDir(), "sessions"), await dreamSessionList()));
		},
	});
}

/** m0354 Z8t(): any later line with non-heading prose kills the shortcut. */
function restHasProse(rest: string): boolean {
	for (const line of rest.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) continue;
		return true;
	}
	return false;
}

/** m0354 eQt(): control characters (C0/C1) disqualify shortcut content. */
function hasControlChars(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code < 32 || (code >= 127 && code <= 159)) return true;
	}
	return false;
}

/** Open a directory in the platform file manager (CC /memory's folder rows). */
async function openFolder(
	pi: ExtensionAPI,
	ctx: { ui: { notify(message: string, kind: "info" | "warning"): void } },
	dir: string,
): Promise<void> {
	const opener = process.platform === "win32" ? "explorer" : process.platform === "darwin" ? "open" : "xdg-open";
	const opened = await pi.exec(opener, [dir], { timeout: 5000 }).catch(() => null);
	ctx.ui.notify(opened ? `Opened ${dir}` : `Folder: ${dir}`, "info");
}

function isInsideMemory(target: string, paths: MemoryPaths): boolean {
	const normalized = target.replace(/\\/g, "/");
	if (normalized.startsWith(paths.personalDir.replace(/\\/g, "/"))) return true;
	return paths.teamDir !== null && normalized.startsWith(paths.teamDir.replace(/\\/g, "/"));
}

function toolError(message: string) {
	return {
		content: [{ type: "text" as const, text: `Error: ${message}` }],
		details: { error: message },
		isError: true,
	};
}

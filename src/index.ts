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
	serializeConversation,
	truncateTail,
	withFileMutationQueue,
	type BuildSystemPromptOptions,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	LIMITS,
	MEMORY_SWITCHES,
	loadConfig,
	resolvePaths,
	legacyMemoryDir,
	type JobModelKey,
	type MemoryConfig,
	type MemoryPaths,
	type MemorySwitches,
} from "./config.js";
import { serializeMemory, slugName, stampProvenance } from "./frontmatter.js";
import {
	buildExtractionPrompt,
	buildJobSystemPrompt,
	checkExtractionGates,
	collectEntriesSince,
	containsSecret,
	flattenIndexLine,
	isDreamPrompt,
	normalizeContent,
	type ProjectInstructions,
} from "./extract.js";
import { buildIndexSection, buildMemoryPromptSection, buildPinnedSection } from "./prompt.js";
import { RecallSession, recallForPrompt } from "./recall.js";
import { ForegroundPrefix, MemoryJobs } from "./workflow.js";
import { DreamRunner } from "./dream.js";
import { saveJobModel, saveMemorySwitches } from "./persistence.js";
import { chooseJobModel, memoryPanelSummary, showMemoryPanel } from "./panel.js";
import {
	ensureDirs,
	formatIndexLine,
	listMemories,
	readFileOrNull,
	readIndex,
	mutateMemory,
	resolveToolPath,
	isInsideMemory,
	isValidFileRef,
	writeFileSafe,
} from "./store.js";

const PAUSED_MESSAGE = "Memory is paused. Run /pause-memory to resume automemory.";
// Pause gates every tool that touches memory-dir files. Claude Code denies
// memory-dir Read AND Write while paused ("will not write or read new memories").
const MEMORY_TOOLS = new Set(["read", "write", "edit", "memory_save"]);
const TRANSCRIPT_MAX_BYTES = 24_000;
// Above this share of the context window, a fork may not fit the job's additions and replies.
const FORK_MAX_CONTEXT_PERCENT = 90;
// Minimal observability, mirroring Claude Code's n() debug logging for memory.
const DEBUG = Boolean(process.env.PI_MEMORY_DEBUG?.trim());
function debug(message: string, ...rest: unknown[]) {
	if (DEBUG) console.error("[pi-memory]", message, ...rest);
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
		invalidateJobs();
		delete (globalThis as Record<string, unknown>)[guardKey];
	});

	let cwd = process.cwd();
	let config: MemoryConfig = loadConfig(cwd);
	let paths: MemoryPaths = resolvePaths(cwd, config);

	let paused = false;
	let enabled = config.enabled;
	/** Session-stable memory prompt snapshot (Claude Code builds it once per session). */
	let memoryPromptSnapshot = "";
	const recallSession = new RecallSession();
	/** Id of the last message entry covered by an extraction (Claude Code's `r` uuid). */
	let lastExtractedId: string | null = null;
	let directWriteSinceExtract = false;
	let sessionId = uuidv7();
	const jobs = new MemoryJobs();
	const foreground = new ForegroundPrefix();
	const dream = new DreamRunner(jobs);
	let generation = 0;
	let parentSystemPrompt: string | undefined;
	let projectInstructions: ProjectInstructions | undefined;
	const invalidateJobs = () => { generation++; dream.cancel(); jobs.cancel(); };
	pi.on("session_before_switch", invalidateJobs);
	pi.on("session_before_fork", invalidateJobs);
	pi.on("session_before_tree", invalidateJobs);
	pi.on("session_before_compact", invalidateJobs);
	const recordDirectWrite = () => {
		invalidateJobs();
		directWriteSinceExtract = true;
		pi.appendEntry("pi-memory:write", {});
	};

	const setStatus = (ctx: ExtensionContext, text: string) => ctx.ui.setStatus("pi-memory", text);

	const statusText = () => {
		const files = listMemories(paths).length;
		return `memory: ${files} file${files === 1 ? "" : "s"}${!enabled ? " · off" : paused ? " · paused" : ""}`;
	};

	const syncActiveTools = () => {
		const active = pi.getActiveTools();
		pi.setActiveTools(enabled ? [...new Set([...active, "memory_save"])] : active.filter((name) => name !== "memory_save"));
	};
	const changeSwitches = async (changes: Partial<MemorySwitches>, ctx: ExtensionContext): Promise<boolean> => {
		const currentConfig = config;
		try {
			ensureDirs(resolvePaths(cwd, { ...config, ...changes }));
			await saveMemorySwitches(cwd, changes);
		} catch (error) {
			ctx.ui.notify(`Memory settings were not saved: ${error instanceof Error ? error.message : String(error)}`, "warning");
			return false;
		}
		if (currentConfig !== config) return false;
		if (!MEMORY_SWITCHES.some(({ key }) => changes[key] !== undefined && changes[key] !== config[key])) return true;
		invalidateJobs();
		Object.assign(config, changes);
		enabled = config.enabled;
		paths = resolvePaths(cwd, config);
		// Explicit scope/citation changes take effect now; ordinary memory writes keep the session prefix stable.
		if (changes.sharedMemory !== undefined || changes.citeMemories !== undefined) snapshotMemoryPrompt();
		syncActiveTools();
		setStatus(ctx, statusText());
		return true;
	};
	// A running job keeps the model it started with; the next job reads the new selection.
	const changeJobModel = async (key: JobModelKey, ctx: ExtensionContext) => {
		const selection = await chooseJobModel(ctx, key);
		if (selection === undefined) return;
		const currentConfig = config;
		try { await saveJobModel(cwd, key, selection); }
		catch (error) { ctx.ui.notify(`Memory settings were not saved: ${error instanceof Error ? error.message : String(error)}`, "warning"); return; }
		if (currentConfig !== config) return;
		if (selection === null) delete config[key];
		else config[key] = selection;
	};
	const changePause = (value: boolean, ctx: ExtensionContext) => {
		if (paused === value) return;
		paused = value;
		invalidateJobs();
		pi.appendEntry("pi-memory:state", { paused });
		setStatus(ctx, statusText());
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
		recallSession.snapshot(paths);
	};


	/**
	 * Memory jobs that run apart from the foreground conversation cannot reuse its prompt cache,
	 * so they carry only the memory rules and Pi's project instructions instead of the whole
	 * foreground prompt. Without Pi's prompt options (an unusual host), keep the inherited prompt.
	 */
	const jobSystemPrompt = (ctx: ExtensionContext | ExtensionCommandContext) => {
		const rules = buildMemoryPromptSection(paths, config.citeMemories);
		const project = "getSystemPromptOptions" in ctx ? captureProjectInstructions(ctx.getSystemPromptOptions()) : projectInstructions;
		return project ? buildJobSystemPrompt(cwd, rules, project) : (parentSystemPrompt ?? ctx.getSystemPrompt()) + "\n\n" + rules;
	};

	/** pi's own compaction-style transcript for the extraction model call. */
	const renderTranscript = (messages: Parameters<typeof convertToLlm>[0]): string => {
		const serialized = serializeConversation(convertToLlm(messages));
		const clipped = truncateTail(serialized, { maxBytes: TRANSCRIPT_MAX_BYTES });
		return clipped.truncated ? `[Earlier transcript omitted (${clipped.truncatedBy} limit); the first displayed record may be partial.]\n${clipped.content}` : clipped.content;
	};

	// State follows selected ancestry; recall follows visible context after compaction.
	const restoreBranchState = (ctx: ExtensionContext) => {
		paused = false;
		lastExtractedId = null;
		directWriteSinceExtract = false;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || typeof entry.data !== "object" || entry.data === null) continue;
			if (entry.customType === "pi-memory:write") directWriteSinceExtract = true;
			if ((entry.customType === "pi-memory:extracted" || entry.customType === "pi-memory:extraction-cursor") && "lastExtractedId" in entry.data && typeof entry.data.lastExtractedId === "string") {
				lastExtractedId = entry.data.lastExtractedId;
				directWriteSinceExtract = false;
			}
			if (entry.customType === "pi-memory:state" && "paused" in entry.data && typeof entry.data.paused === "boolean")
				paused = entry.data.paused;
		}
	};

	/** Run the gated extraction flow; returns a human-readable result line. */
	const runExtraction = async (ctx: ExtensionContext, force: boolean): Promise<string> => {
		if (!enabled || paused) return paused ? PAUSED_MESSAGE : "Memory is disabled for this project.";
		const branch = ctx.sessionManager.buildContextEntries();
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
				directWriteSinceExtract = false;
			}
			return `skipped: ${gate.reason}`;
		}

		const prompt = buildExtractionPrompt(paths, renderTranscript(recent.map((view) => view.message)), recent.length);
		const usage = ctx.getContextUsage();
		const settings = pi.getSettings();
		const prefix = usage?.percent != null && usage.percent > FORK_MAX_CONTEXT_PERCENT ? undefined : foreground.fork(
			{ sessionId: ctx.sessionManager.getSessionId(), thinkingBudgets: settings.thinkingBudgets },
			settings.images?.blockImages === true,
		);
		const startedGeneration = generation;
		setStatus(ctx, "memory: extracting…");
		try {
			const result = await jobs.run(ctx, {
				kind: "extract", paths, sessionId, prompt, model: config.extractModel, sessionThinkingLevel: pi.getThinkingLevel(),
				fork: prefix && { prefix, input: buildExtractionPrompt(paths, null, recent.length).input },
				systemPrompt: jobSystemPrompt(ctx),
			});
			if (startedGeneration !== generation) return `extraction cancelled after session state changed; ${result.applied} operation(s) already applied`;
			if (result.status === "completed") {
				lastExtractedId = lastEntryId ?? lastExtractedId;
				directWriteSinceExtract = false;
			}
			if (result.status === "completed" || result.applied > 0)
				pi.appendEntry("pi-memory:extracted", { lastExtractedId, written: result.written, status: result.status });
			return `extraction ${result.status}: ${result.applied} operation(s)${formatIssues(result)}`;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return `extraction failed: ${message}`;
		} finally {
			if (startedGeneration === generation) setStatus(ctx, statusText());
		}
	};

	const runDream = async (ctx: ExtensionContext, automatic: boolean): Promise<string | null> => {
		if (!enabled || paused) return automatic ? null : paused ? PAUSED_MESSAGE : "Memory is disabled for this project.";
		const startedGeneration = generation;
		setStatus(ctx, "memory: consolidating…");
		const result = await dream.run(ctx, {
			automatic, paths, sessionId, model: config.dreamModel, sessionThinkingLevel: pi.getThinkingLevel(),
			systemPrompt: jobSystemPrompt(ctx),
		});
		if (startedGeneration !== generation) return automatic ? null : `Dream cancelled after session state changed; ${result.status === "skipped" ? 0 : result.applied} operation(s) already applied`;
		setStatus(ctx, statusText());
		if (result.status === "skipped") return null;
		if (result.applied > 0) pi.appendEntry("pi-memory:dream", { written: result.written, status: result.status });
		return `Dream ${result.status}: ${result.applied} operation(s)${formatIssues(result)}`;
	};

	const runManualDream = async (ctx: ExtensionCommandContext) => {
		const startedGeneration = generation;
		await ctx.waitForIdle();
		if (startedGeneration !== generation) { ctx.ui.notify("Dream cancelled after session state changed.", "info"); return; }
		ctx.ui.notify((await runDream(ctx, false)) ?? "Dream skipped.", "info");
	};

	pi.on("session_start", async (_event, ctx) => {
		invalidateJobs();
		parentSystemPrompt = undefined;
		projectInstructions = undefined;
		foreground.reset();
		cwd = ctx.cwd;
		config = loadConfig(cwd);
		enabled = config.enabled;
		syncActiveTools();
		paths = resolvePaths(cwd, config);
		ensureDirs(paths);
		const legacy = legacyMemoryDir(cwd, paths);
		if (listMemories({ ...paths, personalDir: legacy, teamDir: null }).length > 0) {
			ctx.ui.notify(`Legacy memories remain at ${legacy}. Use /memory import-legacy to copy them into this project's isolated directory.`, "info");
		}
		recallSession.reset();
		paused = false;
		lastExtractedId = null;
		directWriteSinceExtract = false;
		sessionId = ctx.sessionManager.getSessionId();
		restoreBranchState(ctx);
		snapshotMemoryPrompt();
		debug("session_start: snapshot chars:", memoryPromptSnapshot.length, "cursor:", lastExtractedId);
		setStatus(ctx, statusText());
	});

	pi.on("session_tree", async (_event, ctx) => {
		invalidateJobs();
		foreground.reset();
		restoreBranchState(ctx);
		setStatus(ctx, statusText());
	});

	pi.on("before_agent_start", async (event, ctx) => {
		invalidateJobs();
		parentSystemPrompt = event.systemPrompt;
		projectInstructions = captureProjectInstructions(event.systemPromptOptions);
		if (!enabled) return;
		setStatus(ctx, statusText());

		if (config.recall && !paused && event.prompt.trim() && !isDreamPrompt(event.prompt)) {
			recallSession.restore(ctx.sessionManager.buildContextEntries());
			const result = recallForPrompt(paths, event.prompt, recallSession, config.citeMemories);
			if (result.reminder) {
				return {
					systemPrompt: event.systemPrompt + (memoryPromptSnapshot ? "\n\n" + memoryPromptSnapshot : ""),
					message: {
						customType: "pi-memory:recall",
						content: result.reminder,
						display: false,
						details: result.details,
					},
				};
			}
		}
		return {
			systemPrompt: event.systemPrompt + (memoryPromptSnapshot ? "\n\n" + memoryPromptSnapshot : ""),
		};
	});

	// Observe-only: the last foreground request and its reply form the prefix an extraction can reuse.
	pi.on("context_with_system", (event) => { foreground.observeRequest(event.messages); });
	pi.on("message_end", (event) => { foreground.observeMessage(event.message); });

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

	pi.on("tool_call", async (event, ctx) => {
		if (!enabled) return;
		if (!MEMORY_TOOLS.has(event.toolName)) return;
		if (event.toolName === "memory_save") {
			if (paused) return { block: true, reason: PAUSED_WRITE_MESSAGE };
			return;
		}
		const target = (event.input as { path?: unknown } | undefined)?.path;
		if (typeof target !== "string") return;
		if (!isInsideMemory(target, paths, ctx.cwd)) return;
		if (paused) {
			return { block: true, reason: event.toolName === "read" ? PAUSED_READ_MESSAGE : PAUSED_WRITE_MESSAGE };
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!enabled || paused || event.isError) return;
		if (event.toolName !== "write" && event.toolName !== "edit") return;
		const target = (event.input as { path?: unknown } | undefined)?.path;
		if (typeof target !== "string" || !isInsideMemory(target, paths, ctx.cwd)) return;
		const absolute = resolveToolPath(target, ctx.cwd);
		// rUn counts any Write/Edit inside the memory dir as a direct write
		// (no extension filter); HD's stamp itself only touches .md files.
		recordDirectWrite();
		if (!target.endsWith(".md")) return;
		// Stamp provenance the way Claude Code's stampNewMemoryContent does:
		// add originSessionId/modified when missing, refresh modified otherwise.
		// Routed through the same mutation queue as memory_save so a parallel
		// save of the same file cannot interleave with the stamp write.
		await withFileMutationQueue(absolute, async () => {
			const raw = readFileOrNull(absolute);
			if (raw !== null) {
				const stamped = stampProvenance(raw, sessionId);
				if (stamped !== raw) {
					writeFileSafe(absolute, stamped);
					debug("stamped provenance:", target);
				}
			}
		});
	});

	// Pi awaits settled hooks. Coalesce overlapping events and serialize Dream
	// after extraction so the two workflows never compete for the model slot.
	let settledInFlight = false;
	let pendingContext: ExtensionContext | undefined;
	const settleMemory = async (ctx: ExtensionContext) => {
		if (!enabled || paused || (!config.autoExtract && !config.autoDream)) return;
		if (settledInFlight) { pendingContext = ctx; return; }
		settledInFlight = true;
		try {
			let next: ExtensionContext | undefined = ctx;
			while (next) {
				const current = next;
				pendingContext = undefined;
				const startedGeneration = generation;
				if (enabled && !paused && config.autoExtract) {
					const result = await runExtraction(current, false);
					if (startedGeneration === generation && current.hasUI && !result.startsWith("skipped: no new messages")) current.ui.notify(`pi-memory: ${result}`, "info");
				}
				if (startedGeneration === generation && !pendingContext && enabled && !paused && config.autoDream) {
					const result = await runDream(current, true);
					if (result && current.hasUI) current.ui.notify(result, "info");
				}
				next = pendingContext;
			}
		} finally { settledInFlight = false; }
	};
	pi.on("agent_settled", async (_event, ctx) => settleMemory(ctx));

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
			const ref = team ? `team/${file}` : file;
			const content = serializeMemory(
				{ name, description, type: params.type, pinned: params.pinned === true, originSessionId: sessionId, modified: new Date().toISOString() },
				body,
			);
			const saved = await mutateMemory(paths, {
				kind: "upsert", ref, content,
				indexLine: params.indexLine?.trim() ? flattenIndexLine(normalizeContent(params.indexLine)) : formatIndexLine(ref, name, description),
			});
			if (!saved.ok) return toolError(saved.error);
			recordDirectWrite();
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

	const switchCommands = MEMORY_SWITCHES.flatMap((setting) => [true, false].map((value) => ({
		command: `${setting.command} ${value ? "on" : "off"}`.trim(), key: setting.key, value, description: setting.description,
	})));
	pi.registerCommand("memory", {
		description: "Configure project memory and branch pause, or run extraction and Dream",
		getArgumentCompletions: (prefix) => [
			...switchCommands.map((setting) => ({ value: setting.command, label: setting.command, description: setting.description })),
			{ value: "import-legacy", label: "import-legacy", description: "Copy legacy memories without overwriting existing files" },
		].filter((item) => item.value.startsWith(prefix.trimStart())),
		handler: async (args, ctx) => {
			const argument = args.trim().split(/\s+/).join(" ");
			const setting = switchCommands.find((candidate) => candidate.command === argument);
			if (setting) {
				if (await changeSwitches({ [setting.key]: setting.value }, ctx)) ctx.ui.notify("Memory settings saved for this project.", "info");
				return;
			}
			if (args.trim() === "import-legacy") {
				if (!enabled || paused) { ctx.ui.notify(paused ? PAUSED_MESSAGE : "Memory is disabled for this project.", "warning"); return; }
				const legacy = legacyMemoryDir(cwd, paths);
				const files = listMemories({ ...paths, personalDir: legacy, teamDir: null });
				let imported = 0;
				for (const file of files) {
					const content = readFileOrNull(file.absolutePath);
					if (content === null || !isValidFileRef(file.ref, false)) continue;
					const result = await mutateMemory(paths, { kind: "upsert", ref: file.ref, content }, new Map([[file.ref, null]]));
					if (result.ok) imported++;
				}
				if (imported > 0) recordDirectWrite();
				ctx.ui.notify(`Imported ${imported} of ${files.length} legacy memories. Existing targets and all legacy files were preserved.`, "info");
				return;
			}
			if (argument) { ctx.ui.notify("Unknown memory setting. Use /memory to configure it, or select a command completion.", "warning"); return; }
			const readState = () => ({ switches: config, paused, paths, models: config });
			if (ctx.mode !== "tui") { ctx.ui.notify(memoryPanelSummary(readState()), "info"); return; }
			let action;
			// Model pickers replace the list temporarily; return to the panel so other settings stay one step away.
			while ((action = await showMemoryPanel(ctx, {
				read: readState,
				change: async (key, value) => {
					if (key === "paused") changePause(value, ctx);
					else await changeSwitches({ [key]: value }, ctx);
				},
			}))?.startsWith("model:")) await changeJobModel(action.slice("model:".length) as JobModelKey, ctx);
			switch (action) {
				case "extract": ctx.ui.notify(await runExtraction(ctx, true), "info"); break;
				case "dream": await runManualDream(ctx); break;
				case "personal-folder": await openFolder(pi, ctx, paths.personalDir); break;
				case "team-folder": if (paths.teamDir) await openFolder(pi, ctx, paths.teamDir); break;
			}
		},
	});

	pi.registerCommand("pause-memory", {
		description: "Pause/resume memory for this branch; use on/off to set pause explicitly",
		getArgumentCompletions: (prefix) => ["on", "off"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const value = args.trim();
			if (value && value !== "on" && value !== "off") { ctx.ui.notify("Use /pause-memory, /pause-memory on, or /pause-memory off.", "warning"); return; }
			changePause(value ? value === "on" : !paused, ctx);
			ctx.ui.notify(paused ? PAUSED_MESSAGE : "Memory resumed · memory content may be referenced and new memories can be saved.", "info");
		},
	});

	pi.registerCommand("memory-extract", {
		description: "Extract memories from this session now",
		handler: async (_args, ctx) => {
			ctx.ui.notify(await runExtraction(ctx, true), "info");
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
			if (!enabled || paused) { ctx.ui.notify(paused ? PAUSED_MESSAGE : "Memory is disabled for this project.", "warning"); return; }
			if (!paths.teamDir) {
				ctx.ui.notify("Shared (team) memory is not enabled — set sharedMemory: true in .pi/memory.json first.", "warning");
				return;
			}
			const ref = args.trim().replace(/^team\//, "");
			if (!/^[a-z0-9][a-z0-9_-]*\.md$/.test(ref)) {
				ctx.ui.notify("Usage: /remember <file.md> (a personal memory filename)", "warning");
				return;
			}
			const promoted = await mutateMemory(paths, { kind: "promote", ref });
			if (!promoted.ok) { ctx.ui.notify(promoted.error, "warning"); return; }
			recordDirectWrite();
			ctx.ui.notify(`Promoted ${ref} to team memory (team/${ref}).`, "info");
		},
	});

	pi.registerCommand("dream", {
		description: "Run a memory-consolidation dream over your memory files",
		handler: async (_args, ctx) => {
			await runManualDream(ctx);
		},
	});
}

function formatIssues(result: { readonly errors: readonly string[]; readonly notices?: readonly string[] }): string {
	const issues = [...(result.notices ?? []), ...result.errors];
	return issues.length ? `; ${issues.join("; ")}` : "";
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


function toolError(message: string) {
	return {
		content: [{ type: "text" as const, text: `Error: ${message}` }],
		details: { error: message },
		isError: true,
	};
}

/** Copy, because Pi's prompt options are mutable and later handlers may edit them. */
function captureProjectInstructions(options: BuildSystemPromptOptions): ProjectInstructions {
	return {
		contextFiles: (options.contextFiles ?? []).map(({ path, content }) => ({ path, content })),
		appendSystemPrompt: options.appendSystemPrompt || undefined,
	};
}

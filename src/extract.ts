/**
 * Background memory extraction (extractMemories port) and the dream prompt.
 *
 * Claude Code forks a sandboxed subagent with a restricted tool set; pi
 * extensions have no subagent API, so this port runs a single structured model
 * call (ctx.modelRegistry.complete) and applies a JSON op protocol through
 * this extension's own validation — no model-driven disk writes at all, which
 * keeps the security boundary without the tool loop.
 */

import {
	LIMITS,
	MEMORY_INDEX,
	MEMORY_TYPES,
	type MemoryPaths,
	type MemoryType,
} from "./config.js";
import {
	listMemories,
	mutateMemory,
	isValidFileRef,
	formatIndexLine,
} from "./store.js";
import { serializeMemory } from "./frontmatter.js";

const DREAM_HEADER = "# Dream: Memory Consolidation";

export interface ExtractionGateResult {
	run: boolean;
	reason: string;
	newMessageCount: number;
	/** Skip gates consume the messages (advance the cursor); the threshold gate does not. */
	advanceCursor: boolean;
}

/** Serializable view of one session entry for gate checks and model calls. */
export interface EntryView {
	role?: string;
	text: string;
	message: unknown;
}

function entryText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((block) => {
				if (typeof block === "string") return block;
				if (block && typeof block === "object" && "text" in block) return String((block as { text: unknown }).text);
				return "";
			})
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

/**
 * Collect message-bearing entries after `sinceEntryId` (null = from the
 * start). The id cursor mirrors Claude Code's extractor, which records the
 * uuid of the last message it covered — robust across compaction and tree
 * navigation, unlike a message count.
 */
export function collectEntriesSince(
	branchEntries: unknown[],
	sinceEntryId: string | null,
): { views: EntryView[]; lastEntryId: string | null } {
	const views: EntryView[] = [];
	let lastEntryId: string | null = sinceEntryId;
	// Compaction or branch navigation may remove the cursor from the visible history.
	let collecting = sinceEntryId === null || !branchEntries.some((entry) =>
		typeof entry === "object" && entry !== null && "id" in entry && entry.id === sinceEntryId);
	for (const entry of branchEntries as Array<Record<string, unknown>>) {
		const id = typeof entry?.id === "string" ? entry.id : null;
		if (!collecting) {
			if (id && id === sinceEntryId) collecting = true;
			continue;
		}
		const message = entry?.message as Record<string, unknown> | undefined;
		if (!message) continue;
		if (id) lastEntryId = id;
		views.push({
			role: typeof message.role === "string" ? message.role : undefined,
			text: entryText(message.content),
			message,
		});
	}
	return { views, lastEntryId };
}

/**
 * Extraction gates — Claude Code's $ln (m0354:106749): direct-write skip
 * (rUn: memory-tool result, or Write/Edit into the memory dir — no .md
 * restriction there), then no-prose skip (oUn/rEt: a non-meta user message
 * with >= 3 whitespace-separated tokens), then the threshold
 * (tengu_bramble_lintel ?? 1). Both skips consume the messages: the original
 * advances the cursor to the last entry's uuid; the threshold does not.
 * Kept plugin difference: the threshold counts messages since the cursor,
 * the original counts gate-passing events (equivalent at the default of 1).
 */
export function checkExtractionGates(
	views: EntryView[],
	minMessages: number,
	directWriteSeen: boolean,
): ExtractionGateResult {
	const count = views.length;
	if (directWriteSeen) {
		return { run: false, reason: "conversation already wrote to memory files directly", newMessageCount: count, advanceCursor: true };
	}
	const hasProse = views.some((view) => {
		if (view.role !== "user") return false;
		return view.text.trim().split(/\s+/).filter(Boolean).length >= 3;
	});
	if (!hasProse) {
		return { run: false, reason: "no user prose since last extraction", newMessageCount: count, advanceCursor: true };
	}
	if (count < minMessages) {
		return { run: false, reason: `only ${count} new message(s), threshold ${minMessages}`, newMessageCount: count, advanceCursor: false };
	}
	return { run: true, reason: "gates passed", newMessageCount: count, advanceCursor: true };
}

const SECRET_PATTERNS: RegExp[] = [
	/sk-ant-[A-Za-z0-9_-]{16,}/,
	/gh[pousr]_[A-Za-z0-9]{20,}/,
	/AKIA[0-9A-Z]{16}/,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
	/xox[baprs]-[A-Za-z0-9-]{10,}/,
];

export function containsSecret(text: string): boolean {
	return SECRET_PATTERNS.some((re) => re.test(text));
}

export interface ExtractOpUpsert {
	op: "upsert";
	file: string;
	type: MemoryType;
	description: string;
	body: string;
	pinned?: boolean;
	indexLine?: string;
}
export interface ExtractOpDelete {
	op: "delete";
	file: string;
}
export type ExtractOp = ExtractOpUpsert | ExtractOpDelete;


/**
 * Port of Claude Code's qF(): normalize memory content before it hits disk —
 * CRLF/unicode line separators to LF, control characters (except tab/newline)
 * and the C1 range become U+FFFD.
 */
export function normalizeContent(text: string): string {
	const lf = text.replace(/\r\n?|[\u2028\u2029]/g, "\n");
	let out = "";
	for (const ch of lf) {
		const code = ch.codePointAt(0) ?? 0;
		out += code !== 9 && code !== 10 && (code < 32 || (code >= 127 && code <= 159)) ? "\uFFFD" : ch;
	}
	return out;
}

/** An index entry must stay one line: flatten any embedded newlines. */
export function flattenIndexLine(line: string): string {
	return line.replace(/[\r\n]+/g, " ").trim();
}

export interface ApplyResult {
	applied: number;
	skipped: string[];
	written: string[];
}

/** Apply the plugin's validated operation protocol through the shared mutation owner. */
export async function applyExtractOps(paths: MemoryPaths, ops: unknown, sessionId: string): Promise<ApplyResult> {
	const result: ApplyResult = { applied: 0, skipped: [], written: [] };
	if (!Array.isArray(ops)) {
		result.skipped.push("response was not a JSON object with an ops array");
		return result;
	}
	for (const raw of ops.slice(0, LIMITS.extractMaxOps)) {
		const op = raw as Record<string, unknown>;
		const file = typeof op?.file === "string" ? op.file : "";
		if (!isValidFileRef(file, paths.teamDir !== null)) {
			result.skipped.push(`${file || "(unnamed)"}: file must be a lowercase .md name (kebab-case, underscores allowed; team/ prefix allowed)`);
			continue;
		}
		if (op?.op === "delete") {
			const deleted = await mutateMemory(paths, { kind: "delete", ref: file });
			if (deleted.ok) { result.applied++; result.written.push(`deleted ${file}`); }
			else result.skipped.push(`${file}: ${deleted.error}`);
			continue;
		}
		if (op?.op !== "upsert") {
			result.skipped.push(`${file}: unknown op`);
			continue;
		}
		const type = op.type as MemoryType;
		const description = normalizeContent(typeof op.description === "string" ? op.description : "").trim();
		const body = normalizeContent(typeof op.body === "string" ? op.body : "").trim();
		if (!MEMORY_TYPES.includes(type)) {
			result.skipped.push(`${file}: type must be one of ${MEMORY_TYPES.join("|")}`);
			continue;
		}
		if (!description) {
			result.skipped.push(`${file}: description is required`);
			continue;
		}
		if (!body) {
			result.skipped.push(`${file}: body is empty`);
			continue;
		}
		if (Buffer.byteLength(body, "utf-8") > LIMITS.fileMaxBytes) {
			result.skipped.push(`${file}: body exceeds ${LIMITS.fileMaxBytes} bytes — split or summarize`);
			continue;
		}
		if (containsSecret(`${file}\n${description}\n${body}`)) {
			result.skipped.push(`${file}: content contains potential secrets and cannot be written to memory`);
			continue;
		}
		const pinned = op.pinned === true;
		const name = file.replace(/\.md$/, "");
		const content = serializeMemory(
			{
				name,
				description,
				type,
				pinned,
				originSessionId: sessionId,
				modified: new Date().toISOString(),
			},
			body,
		);
		const indexLine =
			typeof op.indexLine === "string" && op.indexLine.trim()
				? flattenIndexLine(normalizeContent(op.indexLine))
				: formatIndexLine(file, name, description);
		const indexResult = await mutateMemory(paths, { kind: "upsert", ref: file, content, indexLine });
		if (!indexResult.ok) {
			result.skipped.push(`${file}: ${indexResult.error}`);
			continue;
		}
		result.applied++;
		result.written.push(file);
	}
	return result;
}

export function buildExtractionPrompt(paths: MemoryPaths, transcript: string, newMessageCount: number): string {
	const memories = listMemories(paths);
	const existing =
		memories.length > 0
			? `\n## Existing memory files\n\n${memories.map((m) => `- ${m.ref} (${m.type ?? "untyped"}) — ${m.description}`).join("\n")}\n\nCheck this list before writing — update an existing file rather than creating a duplicate.`
			: "";
	return [
		"You are now acting as the memory extraction subagent. Analyze the most recent messages below and use them to update your persistent memory systems.",
		"",
		`You MUST only use content from the last ~${newMessageCount} messages. Do not waste any turns attempting to investigate or verify that content further — no grepping source files, no reading code to confirm a pattern exists, no git commands.`,
		existing,
		"",
		"Apply the memory types, what-not-to-save criteria, and frontmatter format from the rules below.", // eEt said “from the Memory section of your system prompt” — this single call carries none, so the criteria are inlined in Rules
		"",
		"Output ONLY a JSON object, no prose, no code fences:",
		'{"ops": [',
		'  {"op": "upsert", "file": "kebab-case-name.md", "type": "user|feedback|project|reference", "description": "one-line summary used for future relevance decisions", "body": "the fact; for feedback/project follow with **Why:** and **How to apply:** lines; link related memories with [[their-name]]", "pinned": false, "indexLine": "- [Title](file.md) — one-line hook under 150 chars"},',
		'  {"op": "delete", "file": "stale-memory.md"}',
		"]}",
		"",
		"Rules: at most one fact per file; keep each body under 4096 bytes; only save what is applicable (changes future behavior), durable (multiple future sessions), and legible (readable without this session); if nothing is worth saving output {\"ops\": []}.",
		"If the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.",
		"",
		"## Recent messages",
		"",
		transcript,
	].join("\n");
}

export function parseExtractResponse(text: string): { ops: unknown[] } | null {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start === -1 || end <= start) return null;
	try {
		const parsed = JSON.parse(text.slice(start, end + 1)) as { ops?: unknown };
		if (Array.isArray(parsed.ops)) return { ops: parsed.ops };
		return null;
	} catch {
		return null;
	}
}

/**
 * Dream prompt — port of Claude Code's `# Dream: Memory Consolidation`
 * (iEt, m0354): four phases, team discipline, and reconciliation against the
 * static instruction files (AGENTS.md here, CLAUDE.md in Claude Code).
 */
export function buildDreamPrompt(paths: MemoryPaths, sessionsDir: string, sessionsSinceDream?: string[]): string {
	const teamSection = paths.teamDir
		? [
			"",
			"## Team memory (`team/` subdirectory)",
			"",
			"The `team/` subtree holds memories shared across everyone working in this repo. Other teammates' sessions write here too — treat it differently from your personal files:",
			"",
			"- **Phase 1:** list `team/` and skim it alongside your personal files. A teammate may have already captured something you'd otherwise duplicate.",
			"- **Phase 3:** Merge near-duplicates *within* `team/` the same way you would personal memories. If a personal memory restates a team memory, delete the personal one.",
			"- **Phase 4 — be conservative pruning `team/`:**",
			"  - DO delete or fix a team memory that is clearly contradicted by the current code, or that a newer team memory marks as superseded.",
			"  - DO NOT delete a team memory just because you don't recognize it or it isn't relevant to *your* recent sessions — a teammate may rely on it.",
			"  - When unsure, leave it. A stale team memory costs little; deleting a teammate's load-bearing note costs a lot.",
			"",
			"Do not promote personal memories into `team/` during a dream — that's a deliberate choice the user makes via `/remember`, not something to do reflexively.",
		].join("\n")
		: "";

	return `${DREAM_HEADER}

	You are performing a dream — a reflective pass over your memory files. Synthesize what you've learned recently into durable, well-organized memories so that future sessions can orient quickly.

Memory directory: \`${paths.personalDir}\`${paths.teamDir ? ` (team memory: \`${paths.teamDir}\`, referenced as \`team/...\`)` : ""}
This directory already exists — write to it directly with the write tool (do not run mkdir or check for its existence).

Session transcripts: \`${sessionsDir}\` (large JSONL files — grep narrowly, don't read whole files)${paths.teamDir ? `\n\n${teamSection}\n` : ""}

---
## Phase 1 — Orient

- List the memory directory to see what already exists
- Read \`${MEMORY_INDEX}\` to understand the current index
- Skim existing topic files so you improve them rather than creating duplicates

## Phase 2 — Gather recent signal

Look for new information worth persisting. Sources in rough priority order:

1. **Existing memories that drifted** — facts that contradict something you see in the codebase now
2. **Transcript search** — if you need specific context (e.g., "what was the error message from yesterday's build failure?"), grep the JSONL transcripts for narrow terms:
   \`grep -rn "<narrow term>" ${sessionsDir}/ --include="*.jsonl" | tail -50\`

Don't exhaustively read transcripts. Look only for things you already suspect matter.

## Phase 3 — Consolidate

For each thing worth remembering, write or update a memory file at the top level of the memory directory. Use the memory file format and type conventions from your system prompt's auto-memory section — it's the source of truth for what to save, how to structure it, and what NOT to save.

Focus on:
- Merging new signal into existing topic files rather than creating near-duplicates
- Converting relative dates ("yesterday", "last week") to absolute dates so they remain interpretable after time passes
- Deleting contradicted facts — if today's investigation disproves an old memory, fix it at the source

## Phase 4 — Prune and index

Update \`${MEMORY_INDEX}\` so it stays under ${LIMITS.indexMaxLines} lines AND under ~25KB. It's an **index**, not a dump — each entry should be one line under ~150 characters: \`- [Title](file.md) — one-line hook\`. Never write memory content directly into it.

- Remove pointers to memories that are now stale, wrong, or superseded
- Demote verbose entries: if an index line is over ~200 chars, it's carrying content that belongs in the topic file — shorten the line, move the detail
- Add pointers to newly important memories
- Resolve contradictions — if two files disagree, fix the wrong one
### Reconcile memories against AGENTS.md

Project AGENTS.md instructions are loaded in your system prompt. For each memory that captures feedback or project conventions (the \`feedback\`/\`project\` types, where tagged), check whether it contradicts an AGENTS.md instruction on the same topic:

- **Memory is stale** — AGENTS.md and the memory describe different procedures for the same task: AGENTS.md is the maintained, checked-in source. Delete the memory, or rewrite it to agree if it carries context worth keeping (the *why* is still useful but the *how* is wrong).
- **AGENTS.md may be stale** — the memory is clearly dated after AGENTS.md and explicitly corrects it: do NOT edit AGENTS.md during a dream. Annotate the memory with "contradicts AGENTS.md — verify which is current" and list it in your summary so the user can update AGENTS.md.
- **Not a conflict** — the memory adds detail AGENTS.md doesn't cover, or narrows an AGENTS.md rule with a stated reason. Leave it.

A \`feedback\` memory's "Why: the user corrected me" framing is not evidence it's newer than AGENTS.md — AGENTS.md may have been updated since.

---
Return a brief summary of what you consolidated, updated, or pruned. If nothing changed (memories are already tight), say so.` +
		(sessionsSinceDream && sessionsSinceDream.length > 0
			? "\n\n## Additional context\n\n" +
				// BFt's dream invocation (m0354:107122) appends tool constraints plus the
				// session list; pi enforces nothing here — this is guidance text.
				"**Tool constraints for this run:** Shell access is restricted to read-only commands (`ls`, `find`, `grep`, `cat`, `stat`, `wc`, `head`, `tail`, and similar) plus deleting `.md` files inside the memory directory (outside protected subdirectories like `.git` or `agents`; `rm` takes no flags except `-f`). Anything else that writes, redirects to a file, or modifies state will be denied. Plan your exploration with this in mind.\n\n" +
				`Sessions since last consolidation (${sessionsSinceDream.length}):\n` +
				sessionsSinceDream.map((name) => `- ${name}`).join("\n")
			: "");
}

/** Vsr (m0354:150885) excludes system-injected turns (auto_dream, extract_memories,
 * prompt_suggestion, compact) from recall triggering; the dream prompt is the one
 * such turn pi injects via sendUserMessage. */
export function isDreamPrompt(prompt: string): boolean {
	return prompt.trimStart().startsWith(DREAM_HEADER);
}


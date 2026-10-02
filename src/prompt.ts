/**
 * The `# Memory` system prompt section.
 *
 * Ported from Claude Code v2.1.252 (m0169 Mn()/no() builders and the Ps
 * stone_shell auto-memory prompt): the full four-type <types> blocks (mLe
 * with <scope> tags when team memory is on, Wyt otherwise), the
 * what-NOT-to-save negative list, the applicable/durable/legible quality
 * bar, the same-reply write discipline, staleness verification rules, and
 * the plan/task boundary. Tool names adapted to pi (read/write tools +
 * the memory_save tool).
 */

import { LIMITS, MEMORY_INDEX, type MemoryPaths } from "./config.js";
import { TYPES_WITH_SCOPE, TYPES_WITHOUT_SCOPE } from "./types-text.js";
import { truncateIndex, type MemoryFileInfo } from "./store.js";

const SAVE_TOOL = "memory_save";

/** Ps (stone_shell): memory files are past snapshots, not source-of-truth. */
const LESSONS_TEXT =
	"The files there are lessons you saved from prior sessions, what you save there in this session is all that persists after the session is completed or if the user stops responding. Read and update your memory so that you learn over time and don't repeat mistakes in the future. When using memories, treat them as past snapshots to verify against current sources, not as a definitive source-of-truth.";

/** Ps (stone_shell): the three-part quality gate every save must pass. */
const QUALITY_BAR_TEXT = [
	"A good memory is applicable, durable, and legible:",
	"",
	"- applicable — would directly change your behavior in future sessions: an approach the user corrected or steered you away from or a standing preference they expressed. Not ambient code context or state, and not something you worked out yourself — the lesson must be something the user told you or corrected you on, not a finding of your own about the code, the tools, or your own mistake.",
	"- durable — applies to multiple future sessions and tasks, not just this one: standing user or team preferences or corrections that will come up again that the user would otherwise have to restate. Not transient task plans or status, or preferences that may only apply to the current task or session. Look for words that widen or narrow the scope of lesson the user is teaching. \"Never...\", \"always...\", \"whenever you...\" widen and are durable. \"this time...\", \"for now..\", narrow. If you are uncertain if a lesson is durable, assume it is not durable and do not save it.",
	"- legible — polished and readable without the original session: one topic per file, connected full sentences like a short, high-quality Wikipedia article. Include the why, not just the what. Avoid shorthand, scratchpad prose, or unresolvable references (\"the fix,\" bare ticket IDs).",
	"",
	"You must NOT save a memory unless you have validated that it is applicable, durable, AND legible.",
].join("\n");

const NOT_SAVE_TEXT = [
	"## What NOT to save in memory",
	"",
	"- Code patterns, conventions, architecture, file paths, or project structure — these can be derived by reading the current project state.",
	"- Git history, recent changes, or who-changed-what — `git log` / `git blame` are authoritative.",
	"- Debugging solutions or fix recipes — the fix is in the code; the commit message has the context.",
	"- Anything already documented in AGENTS.md files.",
	"- Ephemeral task details: in-progress work, temporary state, current conversation context.",
	"",
	"These exclusions apply even when the user explicitly asks you to save. If they ask you to save a PR list or activity summary, ask what was *surprising* or *non-obvious* about it — that is the part worth keeping.",
].join("\n");

const VERIFY_TEXT = [
	"## Before recommending from memory",
	"",
	"A memory that names a specific function, file, or flag is a claim that it existed *when the memory was written*. It may have been renamed, removed, or never merged. Before recommending it:",
	"",
	"- If the memory names a file path: check the file exists.",
	"- If the memory names a function or flag: grep for it.",
	"- If the user is about to act on your recommendation (not just asking about history), verify first.",
	"",
	'"The memory says X exists" is not the same as "X exists now."',
	"",
	"A memory that summarizes repo state (activity logs, architecture snapshots) is frozen in time. If the user asks about *recent* or *current* state, prefer `git log` or reading the code over recalling the snapshot.",
].join("\n");

const STALENESS_TEXT =
	"- Memory records can become stale over time. Use memory as context for what was true at a given point in time. Before answering the user or building assumptions based solely on information in memory records, verify that the memory is still correct and up-to-date by reading the current state of the files or resources. If a recalled memory conflicts with current information, trust what you observe now — and update or remove the stale memory rather than acting on it.";

const WHEN_TO_ACCESS = [
	"## When to access memories",
	"- When memories seem relevant, or the user references prior-conversation work.",
	"- You MUST access memory when the user explicitly asks you to check, recall, or remember.",
	"- If the user says to *ignore* or *not use* memory: Do not apply remembered facts, cite, compare against, or mention memory content.",
	STALENESS_TEXT,
].join("\n");

const BOUNDARY_TEXT = [
	"## Memory and other forms of persistence",
	"Memory is one of several persistence mechanisms available to you as you assist the user in a given conversation. The distinction is often that memory can be recalled in future conversations and should not be used for persisting information that is only useful within the scope of the current conversation.",
	"- When to use or update a plan instead of memory: If you are about to start a non-trivial implementation task and would like to reach alignment with the user on your approach you should use a Plan rather than saving this information to memory. Similarly, if you already have a plan within the conversation and you have changed your approach persist that change by updating the plan rather than saving a memory.",
	"- When to use or update tasks instead of memory: When you need to break your work in current conversation into discrete steps or keep track of your progress use tasks instead of saving to memory. Tasks are great for persisting information about the work that needs to be done in the current conversation, but memory should be reserved for information that will be useful in future conversations.",
].join("\n");

export function buildMemoryPromptSection(paths: MemoryPaths, citeMemories: boolean): string {
	const parts: string[] = [];

	parts.push(
		"# Memory",
		"",
		`You have a persistent, file-based memory at \`${paths.personalDir}\`${
			paths.teamDir ? ` and a shared team memory at \`${paths.teamDir}\` (referenced as \`team/...\`)` : ""
		}. These directories already exist — write to them directly with the write tool (do not run mkdir or check for their existence).`,
		"",
		"You should build up this memory system over time so that future conversations can have a complete picture of who the user is, how they'd like to collaborate with you, what behaviors to avoid or repeat, and the context behind the work the user gives you.",
		"",
		LESSONS_TEXT,
		"",
		QUALITY_BAR_TEXT,
		"",
		"If the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.",
		"",
		...(paths.teamDir ? TYPES_WITH_SCOPE : TYPES_WITHOUT_SCOPE),
		"",
		NOT_SAVE_TEXT,
		...(paths.teamDir
			? ["", "- You MUST avoid saving sensitive data within shared team memories. For example, never save API keys or user credentials."]
			: []),
		"",
		"## How to save memories",
		"",
		`Saving a memory is a two-step process:`,
		"",
		`**Step 1** — write the memory to its own file ${
			paths.teamDir
				? "in the chosen directory (private or team, per the type's scope guidance)"
				: "(e.g., `user_role.md`, `feedback_testing.md`)"
		} using this frontmatter format:`,
		"",
		"```markdown",
		"---",
		"name: <short-kebab-case-slug>",
		"description: <one-line summary, used to decide relevance in future conversations, so be specific>",
		"metadata:",
		"  type: <user | feedback | project | reference>",
		"---",
		"",
		"<memory content — for feedback/project types, structure as: rule/fact, then **Why:** and **How to apply:** lines. Link related memories with [[their-name]].>",
		"```",
		"",
		"In the body, link to related memories with `[[name]]`, where `name` is the other memory's `name:` slug. Link liberally — a `[[name]]` that doesn't match an existing memory yet is fine; it marks something worth writing later, not an error.",
		"",
		`The easiest way to do both steps at once is the \`${SAVE_TOOL}\` tool: it writes the file with provenance stamps and updates the index in one call.`,
		"",
		paths.teamDir
			? `**Step 2** — add a pointer to that file in \`${MEMORY_INDEX}\` in the private directory. The single \`${MEMORY_INDEX}\` indexes both private and team memories — use a path like \`file.md\` for private memories and \`team/file.md\` for team memories. Each entry should be one line, under ~150 characters: \`- [Title](file.md) — one-line hook\`. It has no frontmatter. Never write memory content directly into \`${MEMORY_INDEX}\`.`
			: `**Step 2** — add a pointer to that file in \`${MEMORY_INDEX}\`. \`${MEMORY_INDEX}\` is an index, not a memory — each entry should be one line, under ~150 characters: \`- [Title](file.md) — one-line hook\`. It has no frontmatter. Never write memory content directly into \`${MEMORY_INDEX}\`.`,
		"",
		`\`${MEMORY_INDEX}\` is always loaded into your conversation context — lines after ${LIMITS.indexMaxLines} will be truncated, so keep the index concise`,
		`- Keep each memory file under ${LIMITS.fileMaxBytes} bytes including frontmatter (recall shows only the first ${LIMITS.fileMaxBytes}) and the description to one specific line; when a file outgrows that, split or summarize it rather than continuing it in a second file.`,
		"- Keep the name, description, and type fields in memory files up-to-date with the content",
		"- Organize memory semantically by topic, not chronologically",
		"- Update or remove memories that turn out to be wrong or outdated",
		"- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.",
		"",
		`A memory file may set \`metadata: pinned: true\` — pinned memories apply to EVERY future session (you may pin up to ${LIMITS.maxPinned}, so be discerning).`,
		"",
		"## When to save",
		"",
		"Check each reply before you send it — including replies that are only tool calls and long execution turns: did the user's latest message teach you a durable, applicable lesson? The only thing you may save this turn is that lesson — not a correction from an earlier turn you let pass at the time. If so, save it in that same reply. Doing what the user asked does not discharge the save, and neither does writing their guidance into a project doc or AGENTS.md: the edit ships this change, the memory is what keeps the preference for next session. If you've decided to write to your memory, you MUST make your memory write before treating your turn as finished — before you send the reply that engages the correction or take your next tool step, not after the conversation settles. If your reply answers the user's \"why…?\", diagnoses what went wrong, applies or proposes a fix, or ends with an offer like \"want me to patch it?\", the correction has already happened and the memory is due now, in that same reply's tool calls; an offered next step is a finished engagement, not permission to defer — don't wait for the user to confirm or come back.",
	);

	if (paths.teamDir) {
		parts.push(
			"",
			"## Memory scope",
			"",
			"There are two scope levels:",
			"",
			`- private: memories that are private between you and the current user. They persist across conversations with only this specific user and are stored at the root \`${paths.personalDir}\`.`,
			`- team: memories that are shared with and contributed by all of the users who work within this project directory. They are stored at \`${paths.teamDir}\` and referenced as \`team/file.md\`.`,
			"",
			"`user` memories are always private; default `feedback` to private, `project` and `reference` to team.",
		);
	}

	// no() swaps the first bullet for the two-directory variant when team memory is on.
	const whenToAccess = paths.teamDir
		? WHEN_TO_ACCESS.replace(
				"- When memories seem relevant, or the user references prior-conversation work.",
				"- When memories (personal or team) seem relevant, or the user references prior work with them or others in their organization.",
			)
		: WHEN_TO_ACCESS;
	parts.push("", whenToAccess, "", VERIFY_TEXT, "");
	if (citeMemories) {
		parts.push(
			"## Citing memories",
			"",
			"Whenever you use or cite content from a memory in communication with the user, always wrap the entire sentence in <cc-memory filenames=\"{comma separated list of memory file names}\">{sentence that references 1 or more memories}</cc-memory> tags. For example: <cc-memory filenames=\"testing-scripts.md\">From a previously saved memory, I see that the command to run tests in this project is `npm test`</cc-memory>",
			"",
			"Only do this in your reply text to the user — never inside tool inputs such as plans, todo items, or question options.",
			"",
		);
	}
	parts.push(BOUNDARY_TEXT);

	return parts.join("\n");
}

/** The `## MEMORY.md` block appended after the prompt section (oo() port). */
export function buildIndexSection(indexContent: string): string {
	if (indexContent.trim()) {
		return `## ${MEMORY_INDEX}\n\n${indexContent}`;
	}
	return `## ${MEMORY_INDEX}\n\nYour ${MEMORY_INDEX} is currently empty. When you save new memories, they will appear here.`;
}

/**
 * Pinned memories injected at session start — Claude Code KHt() (m0354):
 * pinned files by modifiedMs desc (listMemories already sorts that way),
 * unreadable/empty ones drop out without backfill, top G0 = 4 injected.
 * Each block is HHt()'s <pinned-memory> shape with Q5e(content, "memory")
 * truncation and flr()'s control-char strip on the path.
 */
export function buildPinnedSection(memories: MemoryFileInfo[], readFile: (abs: string) => string | null): string {
	const pinned = memories.filter((m) => m.pinned);
	if (pinned.length === 0) return "";
	const blocks: string[] = [];
	for (const m of pinned) {
		if (blocks.length >= LIMITS.maxPinned) break;
		const raw = readFile(m.absolutePath);
		if (raw === null || raw.trim() === "") continue;
		const ref = m.ref.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, "");
		blocks.push(`<pinned-memory path="${ref}">\n${truncateIndex(raw, "memory").content.trim()}\n</pinned-memory>`);
	}
	if (blocks.length === 0) return "";
	return `# Pinned memories (apply to every conversation)\n\n${blocks.join("\n\n")}`;
}

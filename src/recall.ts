/**
 * Recall: pick memories relevant to the user's prompt and render them as a
 * `<system-reminder>` attachment.
 *
 * Simplified port of Claude Code's relevant_memories machinery: per-file cap
 * (4096 bytes / 200 lines), context dedupe, byte budget, revision refresh, per-memory
 * header with age disclaimer ("Memories are point-in-time observations..."),
 * and the "use only if it actually applies" framing. Selection uses keyword
 * scoring over name/description/body instead of Claude Code's index/LLM
 * selector pair (documented trade-off in the README).
 */

import { createHash } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { LIMITS, MEMORY_INDEX, type MemoryPaths } from "./config.js";
import { indexPath, listMemories, readFileOrNull, readMemoryFile, truncateMemory, truncateIndex, type MemoryFileInfo } from "./store.js";

interface MemoryRevision {
	readonly ref: string;
	readonly fingerprint: string | null;
}

/** Stored on the message that actually entered model context, not on an attempted recall. */
export interface RecallDetails {
	readonly version: 1;
	readonly revisions: readonly MemoryRevision[];
	readonly bytes: number;
}

function fingerprint(content: string | null): string | null {
	return content === null ? null : createHash("sha256").update(content).digest("hex");
}

function parseDetails(value: unknown): RecallDetails | null {
	if (typeof value !== "object" || value === null || !("version" in value) || value.version !== 1 ||
		!("bytes" in value) || typeof value.bytes !== "number" || !Number.isSafeInteger(value.bytes) || value.bytes < 0 ||
		!("revisions" in value) || !Array.isArray(value.revisions)) return null;
	const revisions: MemoryRevision[] = [];
	for (const item of value.revisions) {
		if (typeof item !== "object" || item === null || !("ref" in item) || typeof item.ref !== "string" ||
			!("fingerprint" in item) || !(item.fingerprint === null || typeof item.fingerprint === "string")) return null;
		revisions.push({ ref: item.ref, fingerprint: item.fingerprint });
	}
	return { version: 1, revisions, bytes: value.bytes };
}

/** Active context owns dedupe and budget; branches and compaction can discard both. */
export class RecallSession {
	private surfaced = new Map<string, string | null>();
	private surfacedBytes = 0;
	private baseline: readonly MemoryRevision[] = [];

	snapshot(paths: MemoryPaths): void {
		this.baseline = [
			{ ref: MEMORY_INDEX, fingerprint: fingerprint(readFileOrNull(indexPath(paths))) },
			...listMemories(paths).filter((m) => m.pinned).slice(0, LIMITS.maxPinned)
				.map((m) => ({ ref: m.ref, fingerprint: fingerprint(readFileOrNull(m.absolutePath)) })),
		];
	}

	restore(entries: readonly SessionEntry[]): void {
		this.reset();
		for (const entry of entries) {
			if (entry.type !== "custom_message" || entry.customType !== "pi-memory:recall") continue;
			const details = parseDetails(entry.details);
			if (details) this.mark(details);
		}
	}

	alreadySurfaced(ref: string): boolean { return this.surfaced.has(ref); }
	revisions(): ReadonlyMap<string, string | null> { return this.surfaced; }
	remainingBytes(): number { return Math.max(0, LIMITS.recallSessionBudgetBytes - this.surfacedBytes); }
	mark(details: RecallDetails): void {
		for (const revision of details.revisions) this.surfaced.set(revision.ref, revision.fingerprint);
		this.surfacedBytes += details.bytes;
	}
	reset(): void {
		this.surfaced = new Map(this.baseline.map((r) => [r.ref, r.fingerprint]));
		this.surfacedBytes = 0;
	}
}

/** Naive stem: strip a plural/gerund suffix so "tests" matches "test". */
function stem(word: string): string {
	if (word.length > 4 && word.endsWith("ing")) return word.slice(0, -3);
	if (word.length > 3 && word.endsWith("es")) return word.slice(0, -2);
	if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
	return word;
}

/**
 * CJK-aware tokenization: Latin/digit words pass through with light stemming;
 * CJK runs contribute single characters AND bigrams (a Chinese word is often
 * 2 characters, and single-char overlap is meaningful signal). Without this,
 * non-Latin prompts tokenize to nothing and recall never fires — Claude Code
 * special-cases CJK queries for the same reason.
 */
function tokenize(text: string): Set<string> {
	const tokens = new Set<string>();
	// Full-width latin/digits (common in CJK input methods) fold to ASCII so
	// "ＮＰＭ" still matches "npm".
	const lowered = text.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)).toLowerCase();
	for (const word of lowered.split(/[^a-z0-9\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/)) {
		if (!word) continue;
		const cjk = word.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/);
		if (cjk) {
			const chars = [...word];
			for (const ch of chars) tokens.add(ch);
			for (let i = 0; i + 1 < chars.length; i++) tokens.add(chars[i] + chars[i + 1]);
			// Latin fragments inside a mixed run (e.g. "用npm测试") still count.
			for (const latin of word.split(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/)) {
				if (latin.length >= 3) tokens.add(stem(latin));
			}
		} else if (word.length >= 3) {
			tokens.add(stem(word));
		}
	}
	return tokens;
}

/**
 * The plugin's selector, replacing Claude Code's dual selector (m0354):
 * LBt() on-disk index search or Ssr() dedicated model call — documented
 * trade-off in the README. Deterministic weights: name token +3,
 * description token +2, type keyword +1, body overlap +3 max below.
 */
function scoreMemory(memory: MemoryFileInfo, queryTokens: Set<string>): number {
	let score = 0;
	for (const token of tokenize(memory.name)) if (queryTokens.has(token)) score += 3;
	for (const token of tokenize(memory.description)) if (queryTokens.has(token)) score += 2;
	if (memory.type) {
		// matching the type keyword itself is weak signal ("feedback", "project"...)
		if (queryTokens.has(memory.type)) score += 1;
	}
	return score;
}

export interface RecallResult {
	readonly reminder: string | null;
	readonly details: RecallDetails;
}

export function recallForPrompt(
	paths: MemoryPaths,
	prompt: string,
	session: RecallSession,
	citeMemories = false,
): RecallResult {
	const allMemories = listMemories(paths);
	const byRef = new Map(allMemories.map((m) => [m.ref, m]));
	const blocks: string[] = [];
	const revisions: MemoryRevision[] = [];
	let totalBytes = 0;
	const remainingBytes = () => session.remainingBytes() - totalBytes;

	// Freshness is checked even for short prompts or exhausted recall budgets: stale
	// instructions must be invalidated even when no more bodies can be injected.
	for (const [ref, previous] of session.revisions()) {
		if (revisions.length >= LIMITS.recallMaxFiles) break;
		const memory = byRef.get(ref);
		const raw = ref === MEMORY_INDEX ? readFileOrNull(indexPath(paths)) : memory ? readFileOrNull(memory.absolutePath) : null;
		const current = fingerprint(raw);
		if (current === previous) continue;
		revisions.push({ ref, fingerprint: current });
		if (raw === null) {
			blocks.push(`Memory removed or unavailable: ${ref}. Discard its earlier contents.`);
			continue;
		}
		const content = ref === MEMORY_INDEX ? truncateIndex(raw).content : memory ? truncateMemory(raw, memory.absolutePath) : null;
		const bytes = content === null ? 0 : Buffer.byteLength(content, "utf8");
		if (content !== null && bytes <= remainingBytes()) {
			totalBytes += bytes;
			blocks.push(`Memory updated: ${ref}. This replaces its earlier contents.\n\n${content}`);
		} else {
			blocks.push(`Memory updated: ${ref}. Discard its earlier contents and read the current file before relying on it; the recall budget cannot include its contents.`);
		}
	}

	// Single-word Latin queries have too little selection signal; CJK queries do not.
	const query = prompt.trim();
	const select = remainingBytes() > 0 && (/\s/.test(query) || /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/.test(query.normalize("NFKC")));
	const queryTokens = tokenize(prompt);
	const memories = select && queryTokens.size ? allMemories.filter((m) => !session.alreadySurfaced(m.ref)) : [];
	// Body overlap is a weak signal worth one read per file, but only worth the
	// IO when the directory is small enough to scan (Claude Code caps scans too).
	const scanBodies = memories.length <= 100;
	const candidates = memories
		.map((m) => {
			let score = scoreMemory(m, queryTokens);
			if (score < 3 && scanBodies) {
				const body = readMemoryFile(m.absolutePath);
				if (body !== null) {
					let overlap = 0;
					for (const token of tokenize(body)) {
						if (queryTokens.has(token) && ++overlap >= 4) break;
					}
					score += Math.min(overlap, 3);
				}
			}
			return { memory: m, score };
		})
		.filter((c) => c.score >= 3)
		.sort((a, b) => b.score - a.score || b.memory.mtimeMs - a.memory.mtimeMs)
		// Ksr(): top 5 candidates after session dedupe.
		.slice(0, LIMITS.recallMaxFiles - revisions.length);
	const ageDays = (mtimeMs: number) => Math.floor((Date.now() - mtimeMs) / 86_400_000);

	for (const { memory } of candidates) {
		const raw = readFileOrNull(memory.absolutePath);
		if (raw === null) continue;
		const content = truncateMemory(raw, memory.absolutePath);
		const bytes = Buffer.byteLength(content, "utf8");
		if (bytes > remainingBytes()) continue;
		totalBytes += bytes;
		revisions.push({ ref: memory.ref, fingerprint: fingerprint(raw) });
		const age = ageDays(memory.mtimeMs);
		// N2e(): no disclaimer at 0-1 days; always "days" beyond that.
		const ageNote =
			age > 1
				? `This memory is ${age} days old. Memories are point-in-time observations, not live state — claims about code behavior or file:line citations may be outdated. Verify against current code before asserting as fact.`
				: "";
		// k9(): the disclaimer forms its own paragraph above the Memory header.
		const header = ageNote ? `${ageNote}\n\nMemory: ${memory.absolutePath}:` : `Memory: ${memory.absolutePath}:`;
		blocks.push(`${header}\n\n${content.trimEnd()}`);
	}

	const details: RecallDetails = { version: 1, revisions, bytes: totalBytes };
	if (blocks.length === 0) return { reminder: null, details };

	const citeNote = citeMemories
		? " When you use or cite content from one of these memories in your reply, wrap the entire sentence in <cc-memory filenames=\"{comma separated memory file names}\">{sentence}</cc-memory> tags (never inside tool inputs)."
		: "";

	const reminder =
		"<system-reminder>\n" +
		"Retrieved for possible relevance — use only if it actually applies to what the user asked." +
		citeNote +
		"\n\n" +
		blocks.join("\n\n") +
		"\n</system-reminder>";

	return { reminder, details };
}

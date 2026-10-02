/**
 * Recall: pick memories relevant to the user's prompt and render them as a
 * `<system-reminder>` attachment.
 *
 * Simplified port of Claude Code's relevant_memories machinery: per-file cap
 * (4096 bytes / 200 lines), session dedupe, session byte budget, per-memory
 * header with age disclaimer ("Memories are point-in-time observations..."),
 * and the "use only if it actually applies" framing. Selection uses keyword
 * scoring over name/description/body instead of Claude Code's index/LLM
 * selector pair (documented trade-off in the README).
 */

import { LIMITS, type MemoryPaths } from "./config.js";
import { listMemories, readMemoryFile, type MemoryFileInfo } from "./store.js";

/**
 * Session dedupe + byte budget — Claude Code's lhr() (m0354): surfaced paths
 * (readFileState) and a content-length total checked against
 * Zgr.MAX_SESSION_BYTES = 61440 at z4n() entry.
 */
export class RecallSession {
	private surfaced = new Set<string>();
	private surfacedBytes = 0;

	alreadySurfaced(ref: string): boolean {
		return this.surfaced.has(ref);
	}

	mark(refs: string[], bytes: number): void {
		for (const ref of refs) this.surfaced.add(ref);
		this.surfacedBytes += bytes;
	}

	budgetExhausted(): boolean {
		return this.surfacedBytes >= LIMITS.recallSessionBudgetBytes;
	}

	reset(): void {
		this.surfaced = new Set();
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
	// "Ｂｕｎ" still matches "bun".
	const lowered = text.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)).toLowerCase();
	for (const word of lowered.split(/[^a-z0-9\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/)) {
		if (!word) continue;
		const cjk = word.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/);
		if (cjk) {
			const chars = [...word];
			for (const ch of chars) tokens.add(ch);
			for (let i = 0; i + 1 < chars.length; i++) tokens.add(chars[i] + chars[i + 1]);
			// Latin fragments inside a mixed run (e.g. "用bun测试") still count.
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
	reminder: string | null;
	refs: string[];
	bytes: number;
}

export function recallForPrompt(
	paths: MemoryPaths,
	prompt: string,
	session: RecallSession,
	citeMemories = false,
): RecallResult {
	if (session.budgetExhausted()) return { reminder: null, refs: [], bytes: 0 };
	// z4n(): single-token queries (no whitespace) skip recall unless they
	// contain CJK/Hangul, which carries enough signal in one "word".
	const query = prompt.trim();
	if (!/\s/.test(query) && !/[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/.test(query.normalize("NFKC"))) {
		return { reminder: null, refs: [], bytes: 0 };
	}
	const queryTokens = tokenize(prompt);
	if (queryTokens.size === 0) return { reminder: null, refs: [], bytes: 0 };

	const memories = listMemories(paths).filter((m) => !session.alreadySurfaced(m.ref) && !m.pinned);
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
		.slice(0, LIMITS.recallMaxFiles);

	if (candidates.length === 0) return { reminder: null, refs: [], bytes: 0 };

	const blocks: string[] = [];
	let totalBytes = 0;
	const ageDays = (mtimeMs: number) => Math.floor((Date.now() - mtimeMs) / 86_400_000);

	for (const { memory } of candidates) {
		const content = readMemoryFile(memory.absolutePath);
		if (content === null) continue;
		totalBytes += content.length;
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

	if (blocks.length === 0) return { reminder: null, refs: [], bytes: 0 };

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

	return { reminder, refs: candidates.map((c) => c.memory.ref), bytes: totalBytes };
}

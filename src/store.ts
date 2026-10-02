/**
 * Memory store operations: directory scan, MEMORY.md index read/truncate,
 * index line upsert/remove, and safe path resolution.
 *
 * Truncation behavior is ported verbatim from Claude Code's Q5e() (m0169):
 * cap the index at 200 lines / 25000 bytes, fall back to the last newline,
 * and append an explicit "> WARNING: ..." block telling the model only part
 * of the index was loaded.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { LIMITS, MEMORY_INDEX, type MemoryPaths } from "./config.js";
import { parseMemory } from "./frontmatter.js";

export interface MemoryFileInfo {
	/** Index-relative reference ("file.md" or "team/file.md"). */
	ref: string;
	absolutePath: string;
	name: string;
	description: string;
	type: string | null;
	pinned: boolean;
	mtimeMs: number;
	bytes: number;
}

export function ensureDirs(paths: MemoryPaths): void {
	fs.mkdirSync(paths.personalDir, { recursive: true });
	if (paths.teamDir) fs.mkdirSync(paths.teamDir, { recursive: true });
}

export function indexPath(paths: MemoryPaths): string {
	return path.join(paths.personalDir, MEMORY_INDEX);
}

/** Scan both roots (team under `team/` prefix) and parse frontmatter. */
export function listMemories(paths: MemoryPaths): MemoryFileInfo[] {
	const out: MemoryFileInfo[] = [];
	scanRoot(paths.personalDir, "", out);
	if (paths.teamDir) scanRoot(paths.teamDir, "team/", out);
	return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function scanRoot(dir: string, prefix: string, out: MemoryFileInfo[]): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.name.startsWith(".") || entry.name === MEMORY_INDEX) continue;
		const abs = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			scanRoot(abs, `${prefix}${entry.name}/`, out);
			continue;
		}
		if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
		try {
			const stat = fs.statSync(abs);
			const parsed = parseMemory(fs.readFileSync(abs, "utf-8"));
			out.push({
				ref: `${prefix}${entry.name}`,
				absolutePath: abs,
				name: parsed.frontmatter.name || entry.name.replace(/\.md$/, ""),
				description: parsed.frontmatter.description,
				type: parsed.frontmatter.type,
				pinned: parsed.frontmatter.pinned,
				mtimeMs: stat.mtimeMs,
				bytes: stat.size,
			});
		} catch {
			// unreadable file: skip it, never break the session on bad memory content
		}
	}
}

export interface IndexRead {
	content: string;
	lineCount: number;
	byteCount: number;
	truncated: boolean;
}

export function readIndex(paths: MemoryPaths): IndexRead {
	return truncateIndex(readFileOrNull(indexPath(paths)) ?? "");
}

/**
 * Claude Code Q5e(): 200-line cap, then 25000-unit cap at a newline boundary.
 * kind "index" renders the MEMORY.md warning; "memory" renders the per-file
 * warning used for pinned injection (Q5e(content, "memory") inside KHt()).
 */
export function truncateIndex(raw: string, kind: "index" | "memory" = "index"): IndexRead {
	const content = raw.trim();
	const lines = content === "" ? 0 : content.split("\n").length;
	const bytes = content.length;
	if (lines <= LIMITS.indexMaxLines && bytes <= LIMITS.indexMaxBytes) {
		return { content, lineCount: lines, byteCount: bytes, truncated: false };
	}
	let clipped = content.split("\n").slice(0, LIMITS.indexMaxLines).join("\n");
	if (clipped.length > LIMITS.indexMaxBytes) {
		const nl = clipped.lastIndexOf("\n", LIMITS.indexMaxBytes);
		clipped = clipped.slice(0, nl > 0 ? nl : LIMITS.indexMaxBytes);
	}
	// Warning wording follows Claude Code's Q5e(): separate phrasings for
	// lines-only, bytes-only, and both limits exceeded.
	const overLines = lines > LIMITS.indexMaxLines;
	const overBytes = bytes > LIMITS.indexMaxBytes;
	const summary = overLines && overBytes
		? `${lines} lines and ${formatBytes(bytes)}`
		: overLines
			? `${lines} lines (limit: ${LIMITS.indexMaxLines})`
			: `${formatBytes(bytes)} (limit: ${formatBytes(LIMITS.indexMaxBytes)}) — ${kind === "index" ? "index entries are too long" : "its lines are too long"}`;
	const subject = kind === "index" ? "MEMORY.md" : "this memory file";
	const advice = kind === "index"
		? "Keep index entries to one line under ~200 chars; move detail into topic files."
		: "Keep each memory file focused on one topic.";
	const warning =
		`\n\n> WARNING: ${subject} is ${summary}. Only part of it was loaded. ${advice}`;
	return { content: clipped + warning, lineCount: lines, byteCount: bytes, truncated: true };
}

function formatBytes(bytes: number): string {
	if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
	return `${bytes}B`;
}

export function readMemoryFile(absolutePath: string, maxBytes = LIMITS.fileMaxBytes): string | null {
	try {
		const raw = fs.readFileSync(absolutePath, "utf-8");
		// Claude Code caps recall rendering at jEe=200 lines and ZX=4096 bytes
		// (chr/RB with truncateOnByteLimit): the byte limit counts real UTF-8
		// bytes, and the truncation note names one reason — the byte limit when
		// it fired, otherwise the line limit.
		const lines = raw.split("\n");
		let clipped = raw;
		let byteTruncated = false;
		if (lines.length > LIMITS.recallMaxLines) clipped = lines.slice(0, LIMITS.recallMaxLines).join("\n");
		if (Buffer.byteLength(clipped, "utf-8") > maxBytes) {
			clipped = sliceToByteLimit(clipped, maxBytes);
			byteTruncated = true;
		}
		if (lines.length <= LIMITS.recallMaxLines && !byteTruncated) return raw;
		const reason = byteTruncated ? `${maxBytes} byte limit` : `first ${LIMITS.recallMaxLines} lines`;
		return (
			clipped +
			`\n\n> This memory file was truncated (${reason}). ` +
			`Use the read tool to view the complete file at: ${absolutePath}`
		);
	} catch {
		return null;
	}
}

/** Longest prefix of `text` that fits in `maxBytes` UTF-8 bytes. */
function sliceToByteLimit(text: string, maxBytes: number): string {
	let end = text.length;
	while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf-8") > maxBytes) end--;
	return text.slice(0, end);
}

/**
 * One-line index entry: `- [Title](file.md) — hook`. The index is a table of
 * contents, never content (Claude Code's two-step save convention).
 */
export function formatIndexLine(ref: string, title: string, hook: string): string {
	const cleanHook = hook.replace(/\s+/g, " ").trim().slice(0, LIMITS.indexLineMaxChars);
	return `- [${title.replace(/[\[\]]/g, "")}](${ref}) — ${cleanHook}`;
}

/**
 * Parse a line's index-entry link target: the `](ref)` immediately followed by
 * the `— hook` separator (or end of line). Falls back to the line's LAST link
 * when no separator is present. This beats first-link parsing: a title that
 * literally contains "](a.md)" (like "- [See docs ](a.md) inside](b.md) — h")
 * resolves to its real target b.md, not a.md.
 */
function indexLineTarget(line: string): string | null {
	const separatorAfter = (index: number): boolean => {
		const rest = line.slice(index);
		return /^\s*(?:—|-|\||$)/.test(rest);
	};
	let lastAnchored: string | null = null;
	let lastAny: string | null = null;
	for (const match of line.matchAll(/\]\(([^)]+)\)/g)) {
		lastAny = match[1];
		if (separatorAfter(match.index + match[0].length)) lastAnchored = match[1];
	}
	return lastAnchored ?? lastAny;
}
export function upsertIndexLine(paths: MemoryPaths, ref: string, line: string): { ok: boolean; error?: string } {
	const file = indexPath(paths);
	const raw = readFileOrNull(file) ?? "";
	// Normalize: drop trailing empty split artifacts so repeated upserts don't
	// accumulate blank lines against the 200-line cap; we re-add one final \n.
	const lines = raw.split("\n");
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	const filtered = lines.filter((l) => indexLineTarget(l) !== ref);
	filtered.push(line);
	if (filtered.length > LIMITS.indexMaxLines) {
		return { ok: false, error: `MEMORY.md index would exceed ${LIMITS.indexMaxLines} lines — merge or prune existing entries first.` };
	}
	const joined = filtered.join("\n");
	if (joined.length > LIMITS.indexMaxBytes) {
		return { ok: false, error: `MEMORY.md index would exceed ${LIMITS.indexMaxBytes} bytes — shorten the line or prune entries.` };
	}
	fs.mkdirSync(paths.personalDir, { recursive: true });
	fs.writeFileSync(file, joined + "\n");
	return { ok: true };
}

export function removeIndexLine(paths: MemoryPaths, ref: string): void {
	const file = indexPath(paths);
	const raw = readFileOrNull(file);
	if (raw === null) return;
	const kept = raw.split("\n").filter((l) => indexLineTarget(l) !== ref);
	while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
	if (kept.length === 0) {
		fs.writeFileSync(file, "");
		return;
	}
	fs.writeFileSync(file, kept.join("\n") + "\n");
}

export function writeFileSafe(absolutePath: string, content: string): void {
	fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
	// Staged write (tmp + rename). Claude Code's local memory writes go
	// through the harness Write/Edit tools' own atomicity; this is the
	// plugin-side equivalent, not a port of a specific CC memory function.
	// a crash mid-write must never leave a truncated memory file or index.
	const tmp = `${absolutePath}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(tmp, content);
	fs.renameSync(tmp, absolutePath);
}

export function deleteFileSafe(absolutePath: string): boolean {
	try {
		fs.unlinkSync(absolutePath);
		return true;
	} catch {
		return false;
	}
}

export function readFileOrNull(absolutePath: string): string | null {
	try {
		return fs.readFileSync(absolutePath, "utf-8");
	} catch {
		return null;
	}
}

export function countPinned(memories: MemoryFileInfo[]): number {
	return memories.filter((m) => m.pinned).length;
}

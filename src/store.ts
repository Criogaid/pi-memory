/**
 * Memory store operations: directory scan, MEMORY.md index read/truncate,
 * transactional structured mutations, and safe path resolution.
 *
 * Truncation behavior is ported verbatim from Claude Code's Q5e() (m0169):
 * cap the index at 200 lines / 25000 bytes, fall back to the last newline,
 * and append an explicit "> WARNING: ..." block telling the model only part
 * of the index was loaded.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { expandHome } from "./config.js";
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
	const raw = readFileOrNull(absolutePath);
	return raw === null ? null : truncateMemory(raw, absolutePath, maxBytes);
}

/** Render and hash the same read snapshot so external edits cannot mismatch revisions. */
export function truncateMemory(raw: string, absolutePath: string, maxBytes = LIMITS.fileMaxBytes): string {
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

export type MemoryChange =
	| { readonly kind: "upsert"; readonly ref: string; readonly content: string; readonly indexLine?: string }
	| { readonly kind: "delete"; readonly ref: string }
	| { readonly kind: "promote"; readonly ref: string };
export type MutationResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

/** Match pi 0.85's tool path expansion at this boundary; its helper is not public. */
export function resolveToolPath(target: string, cwd: string): string {
	let normalized = target.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ").replace(/^@/, "");
	if (process.platform === "win32" && !normalized.startsWith("//") && !normalized.includes("\\")) {
		const drive = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(normalized);
		if (drive) normalized = `${drive[1].toUpperCase()}:\\${drive[2]?.replaceAll("/", "\\") ?? ""}`;
	}
	if (normalized.startsWith("file://")) normalized = fileURLToPath(normalized);
	else if (normalized === "~" || normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) normalized = expandHome(normalized);
	return path.resolve(cwd, normalized);
}

function canonicalPath(target: string): string {
	try { return fs.realpathSync.native(target); } catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		const parent = path.dirname(target);
		return parent === target ? target : path.join(canonicalPath(parent), path.basename(target));
	}
}

export function containsPath(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

/** Recognize aliases for pause checks, while writes separately reject escaping symlinks. */
export function isInsideMemory(target: string, paths: MemoryPaths, cwd: string): boolean {
	const absolute = resolveToolPath(target, cwd);
	return [paths.personalDir, paths.teamDir].some((root) => root !== null &&
		(containsPath(root, absolute) || containsPath(canonicalPath(root), canonicalPath(absolute))));
}

const RESERVED_FILE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
export function isValidFileRef(ref: string, hasTeam: boolean): boolean {
	if (ref.startsWith("team/") && !hasTeam) return false;
	const name = ref.replace(/^team\//, "");
	const segments = name.split("/");
	const file = segments.pop();
	return file !== undefined && /^[a-z0-9][a-z0-9_-]*\.md$/.test(file) && file !== "memory.md"
		&& !RESERVED_FILE_NAME.test(file.slice(0, -3))
		&& segments.every((segment) => /^[a-z0-9][a-z0-9_-]*$/.test(segment) && !RESERVED_FILE_NAME.test(segment));
}

export function memoryPath(paths: MemoryPaths, ref: string): string {
	if (!isValidFileRef(ref, paths.teamDir !== null)) throw new Error(`Invalid memory reference: ${ref}`);
	const root = ref.startsWith("team/") ? paths.teamDir : paths.personalDir;
	if (!root) throw new Error("Team memory is not enabled");
	const target = path.join(root, ref.replace(/^team\//, ""));
	if (!containsPath(canonicalPath(root), canonicalPath(target))) throw new Error(`Memory path escapes its directory: ${ref}`);
	return target;
}

function readExisting(target: string): Buffer | null {
	try { return fs.readFileSync(target); } catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
		throw error;
	}
}

function changeIndex(raw: string, ref: string, line?: string): string {
	const lines = raw.split(/\r?\n/).filter((entry) => indexLineTarget(entry) !== ref);
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	if (line !== undefined) lines.push(line);
	return lines.length ? `${lines.join("\n")}\n` : "";
}

async function withQueues<T>(files: readonly string[], run: () => T | Promise<T>): Promise<T> {
	const [first, ...rest] = files;
	return first === undefined ? run() : withFileMutationQueue(first, () => withQueues(rest, run));
}

/**
 * Own memory/index invariants for every structured writer. Locks use sorted absolute
 * paths (index plus affected files), so built-in edits share the file lock without cycles.
 * Preflight runs inside serialization. Individual replacements are atomic; ordinary
 * failures restore original bytes. A process/OS crash between renames is not a transaction.
 */
export async function mutateMemory(paths: MemoryPaths, change: MemoryChange, expected?: ReadonlyMap<string, string | null>, signal?: AbortSignal): Promise<MutationResult> {
	const source = memoryPath(paths, change.ref);
	const targetRef = change.kind === "promote" ? `team/${change.ref}` : change.ref;
	if (change.kind === "promote" && change.ref.startsWith("team/")) return { ok: false, error: "Only personal memories can be promoted" };
	const target = memoryPath(paths, targetRef);
	const index = indexPath(paths);
	const keys = [...new Set([source, target, index])].sort();
	return withQueues(keys, () => {
		signal?.throwIfAborted();
		// Recheck after waiting: another tool may have replaced a path with a symlink.
		memoryPath(paths, change.ref);
		memoryPath(paths, targetRef);
		if (!containsPath(canonicalPath(paths.personalDir), canonicalPath(index))) {
			return { ok: false, error: "MEMORY.md resolves outside the personal memory directory" };
		}
		if (expected) for (const [ref, content] of expected) {
			if ((readExisting(memoryPath(paths, ref))?.toString("utf8") ?? null) !== content) {
				return { ok: false, error: `Memory changed after it was read: ${ref}; read again before retrying` };
			}
		}
		const original = new Map(keys.map((file) => [file, readExisting(file)]));
		const before = original.get(source);
		let content: string;
		let nextIndex = original.get(index)?.toString("utf8") ?? "";
		if (change.kind === "delete") {
			if (!before) return { ok: false, error: `No memory named ${change.ref}` };
			content = "";
			nextIndex = changeIndex(nextIndex, change.ref);
		} else {
			if (change.kind === "promote") {
				if (!before) return { ok: false, error: `No personal memory named ${change.ref}` };
				if (original.get(target) !== null) return { ok: false, error: `Team memory already exists: ${targetRef}; merge or rename it before promotion` };
				content = before.toString("utf8");
				nextIndex = changeIndex(nextIndex, change.ref);
			} else content = change.content;
			const memory = parseMemory(content);
			const pinned = listMemories(paths).filter((item) => item.pinned && item.ref !== change.ref && item.ref !== targetRef).length;
			if (memory.frontmatter.pinned && pinned >= LIMITS.maxPinned) return { ok: false, error: `Pinned memory limit (${LIMITS.maxPinned}) reached; unpin one first` };
			const line = change.kind === "upsert" && change.indexLine !== undefined ? change.indexLine : formatIndexLine(targetRef, memory.frontmatter.name, memory.frontmatter.description);
			if (/[\r\n]/.test(line) || indexLineTarget(line) !== targetRef) return { ok: false, error: `Index entry must be one line linking to ${targetRef}` };
			nextIndex = changeIndex(nextIndex, targetRef, line);
			if (nextIndex.trimEnd().split("\n").length > LIMITS.indexMaxLines) return { ok: false, error: `MEMORY.md index would exceed ${LIMITS.indexMaxLines} lines; merge or prune entries first` };
			if (nextIndex.trimEnd().length > LIMITS.indexMaxBytes) return { ok: false, error: `MEMORY.md index would exceed ${LIMITS.indexMaxBytes} characters; shorten or prune entries first` };
		}
		const modified: string[] = [];
		try {
			if (change.kind !== "delete") { writeFileSafe(target, content); modified.push(target); }
			writeFileSafe(index, nextIndex); modified.push(index);
			if (change.kind !== "upsert") { fs.unlinkSync(source); modified.push(source); }
			return { ok: true };
		} catch (error) {
			try {
				for (const file of modified.reverse()) {
					const bytes = original.get(file);
					if (bytes) writeFileSafe(file, bytes);
					else fs.rmSync(file, { force: true });
				}
			} catch (rollbackError) {
				throw new AggregateError([error, rollbackError], "Memory update failed and rollback failed; inspect the memory file and MEMORY.md before retrying");
			}
			throw new Error("Memory update failed; original files were restored", { cause: error });
		}
	});
}

export function writeFileSafe(absolutePath: string, content: string | Buffer): void {
	fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
	const tmp = `${absolutePath}.${process.pid}.${randomUUID()}.tmp`;
	try {
		fs.writeFileSync(tmp, content, { flag: "wx" });
		fs.renameSync(tmp, absolutePath);
	} finally {
		fs.rmSync(tmp, { force: true });
	}
}

export function readFileOrNull(absolutePath: string): string | null {
	try {
		return fs.readFileSync(absolutePath, "utf-8");
	} catch {
		return null;
	}
}

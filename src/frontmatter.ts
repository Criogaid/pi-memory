/**
 * Memory file frontmatter: parse, serialize, and provenance stamping.
 *
 * Format ported from Claude Code's auto-memory (m0169 Wr()/Y7n() and the
 * stampNewMemoryContent HD() flow): every memory is one markdown file holding
 * one fact, with `name` / `description` / `metadata.type` frontmatter, plus
 * `originSessionId` / `modified` provenance stamped by the tooling on write.
 */

import type { MemoryType } from "./config.js";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export interface MemoryFrontmatter {
	name: string;
	description: string;
	type: MemoryType | null;
	pinned: boolean;
	originSessionId: string | null;
	modified: string | null;
}

export interface ParsedMemory {
	frontmatter: MemoryFrontmatter;
	body: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseMemory(raw: string): ParsedMemory {
	const match = FRONTMATTER_RE.exec(raw);
	if (match) {
		// Prefer pi's strict YAML frontmatter parser; fall back to the lenient
		// line scanner for hand-edited files it would reject.
		try {
			const { frontmatter: data } = parseFrontmatter<Record<string, unknown>>(raw);
			const metadata = (data.metadata ?? {}) as Record<string, unknown>;
			const type = String(metadata.type ?? "") as MemoryType;
			return {
				frontmatter: {
					name: typeof data.name === "string" ? data.name : "",
					description: typeof data.description === "string" ? data.description : "",
					type: ["user", "feedback", "project", "reference"].includes(type) ? type : null,
					pinned: metadata.pinned === true,
					originSessionId: pickString((data.metadata as Record<string, unknown> | undefined)?.originSessionId ?? data.originSessionId),
					modified: pickString((data.metadata as Record<string, unknown> | undefined)?.modified ?? data.modified),
				},
				body: raw.slice(match[0].length),
			};
		} catch {
			// fall through to the lenient parser
		}
	}
	return parseMemoryLenient(raw);
}

function parseMemoryLenient(raw: string): ParsedMemory {
	const match = FRONTMATTER_RE.exec(raw);
	if (!match) {
		return {
			frontmatter: {
				name: "",
				description: "",
				type: null,
				pinned: false,
				originSessionId: null,
				modified: null,
			},
			body: raw,
		};
	}
	const lines = match[1].split(/\r?\n/);
	const fm: MemoryFrontmatter = {
		name: "",
		description: "",
		type: null,
		pinned: false,
		originSessionId: null,
		modified: null,
	};
	let inMetadata = false;
	for (const line of lines) {
		const key = /^(\s*)([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
		if (!key) continue;
		const indent = key[1].length;
		const field = key[2];
		const value = key[3].trim();
		if (indent === 0) {
			inMetadata = field === "metadata" && value === "";
			if (field === "name") fm.name = unquote(value);
			if (field === "description") fm.description = unquote(value);
			if (field === "originSessionId") fm.originSessionId = unquote(value) || null;
			if (field === "modified") fm.modified = unquote(value) || null;
			continue;
		}
		if (inMetadata && field === "type") {
			const t = unquote(value) as MemoryType;
			fm.type = ["user", "feedback", "project", "reference"].includes(t) ? t : null;
		}
		if (inMetadata && field === "pinned") fm.pinned = value === "true";
		if (inMetadata && field === "originSessionId") fm.originSessionId = unquote(value) || null;
		if (inMetadata && field === "modified") fm.modified = unquote(value) || null;
	}
	return { frontmatter: fm, body: raw.slice(match[0].length) };
}

/**
 * YAML-quote a scalar when needed (Claude Code's quoteLossyValues): values
 * containing ": ", leading indicators, quotes, or newlines would otherwise
 * produce frontmatter that strict YAML parsers reject.
 */
function yamlQuote(value: string): string {
	if (value === "") return '""';
	if (/^[A-Za-z0-9._/@-]+$/.test(value)) return value; // plainly safe
	const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
	return `"${escaped}"`;
}

/**
 * Canonical file shape — Claude Code's Y7n(): the name goes through ps()
 * (conforming [a-z0-9_-] slugs pass through, anything else is hyphenated),
 * metadata always opens with `node_type: memory`, and the provenance stamp
 * (originSessionId/modified) lives inside metadata (K7n merge semantics).
 * Root keys beyond name/description/metadata drop, as in Y7n.
 */
export function serializeMemory(
	frontmatter: Omit<MemoryFrontmatter, "pinned" | "type"> & {
		type: MemoryType | null;
		pinned?: boolean;
	},
	body: string,
): string {
	const lines = [
		"---",
		`name: ${yamlQuote(slugName(frontmatter.name))}`,
		`description: ${yamlQuote(frontmatter.description)}`,
		"metadata:",
		"  node_type: memory",
	];
	if (frontmatter.type) lines.push(`  type: ${frontmatter.type}`);
	if (frontmatter.pinned) lines.push("  pinned: true");
	lines.push(`  originSessionId: ${yamlQuote(frontmatter.originSessionId ?? "")}`);
	lines.push(`  modified: ${yamlQuote(frontmatter.modified ?? new Date().toISOString())}`);
	lines.push("---", "", body.replace(/^\n+/, "").trimEnd(), "");
	return lines.join("\n");
}

/** m0169 ps(): conforming [a-z0-9_-] names pass through; others are hyphen-slugified. */
export function slugName(raw: string): string {
	return /^[a-z0-9_-]+$/.test(raw) ? raw : raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Stamp provenance on freshly written memory content — ported from Claude
 * Code's stampNewMemoryContent (HD). Unstamped files are re-serialized into
 * the canonical Y7n() shape: ps()-slug name, `node_type: memory` opening
 * metadata, stamp nested inside metadata (K7n). Already-stamped files only
 * get their `modified:` line refreshed in place (nQt), which works for both
 * nested and legacy root-level placement.
 */
export function stampProvenance(raw: string, sessionId: string): string {
	const match = FRONTMATTER_RE.exec(raw);
	if (!match) return raw;
	const now = new Date().toISOString();
	const block = match[1];
	const eol = block.includes("\r\n") ? "\r\n" : "\n";
	const lines = block.split(/\r?\n/);
	if (!lines.some((line) => /^\s*originSessionId\s*:/.test(line))) {
		// Y7n(): name/description/metadata survive; other root keys drop.
		let name = "";
		let description = "";
		const metadata: string[] = [];
		let inMetadata = false;
		for (const line of lines) {
			const m = /^(\s*)([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
			if (!m) continue;
			if (m[1].length === 0) {
				inMetadata = m[2] === "metadata" && m[3].trim() === "";
				if (m[2] === "name") name = unquote(m[3].trim());
				if (m[2] === "description") description = unquote(m[3].trim());
				continue;
			}
			if (inMetadata && m[2] !== "node_type") metadata.push(`  ${m[2]}: ${m[3].trim()}`);
		}
		const canonical = [
			"---",
			`name: ${yamlQuote(slugName(name))}`,
			`description: ${yamlQuote(description)}`,
			"metadata:",
			"  node_type: memory",
			...metadata,
			`  originSessionId: ${sessionId}`,
			`  modified: ${now}`,
			"---",
		].join("\n");
		return canonical + "\n" + raw.slice(match[0].length).replace(/^\n+/, "");
	}
	let refreshed = false;
	for (let i = 0; i < lines.length; i++) {
		const m = /^(\s*modified\s*:\s*)(.*)$/.exec(lines[i]);
		if (m) {
			lines[i] = `${m[1]}${now}`;
			refreshed = true;
			break;
		}
	}
	if (!refreshed) {
		const idx = lines.findIndex((line) => /^\s*originSessionId\s*:/.test(line));
		lines.splice(idx + 1, 0, `modified: ${now}`);
	}
	return raw.replace(block, lines.join(eol));
}

/** Provenance keys live in metadata (canonical); legacy root placement still reads. */
function pickString(value: unknown): string | null {
	return typeof value === "string" && value ? value : null;
}

function unquote(value: string): string {
	if (value.length >= 2 && ((value[0] === '"' && value.endsWith('"')) || (value[0] === "'" && value.endsWith("'")))) {
		return value.slice(1, -1);
	}
	return value;
}

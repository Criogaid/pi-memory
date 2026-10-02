/**
 * pi-memory configuration: directory layout, slugs, and per-session flags.
 *
 * Directory layout mirrors Claude Code's auto-memory:
 *   personal memory  ~/.pi/agent/memory/<project-slug>/
 *   project (team)   <project>/.pi/memory/            (opt-in via config.sharedMemory)
 *   index            MEMORY.md inside the personal dir, indexing both roots
 *                    (team entries prefixed with `team/`, same as Claude Code).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const MEMORY_INDEX = "MEMORY.md";

/**
 * Hard limits ported from Claude Code v2.1.252: index 200 lines / 25000 units
 * and the 150-char index hook (m0169 VD/VF, Q5e + index-line builders),
 * recall 200 lines / 4096 bytes (m0169 jEe/ZX, chr), 5 files per recall
 * (m0354 Ksr slice(0,5)), 61440-unit session budget (m0354 Zgr), 4 pinned
 * (m0354 G0). extractMaxOps is plugin-specific.
 */
export const LIMITS = {
	indexMaxLines: 200,
	indexMaxBytes: 25_000,
	indexLineMaxChars: 150,
	fileMaxBytes: 4096,
	recallMaxLines: 200,
	recallMaxFiles: 5,
	recallSessionBudgetBytes: 61_440,
	maxPinned: 4,
	extractMaxOps: 6,
} as const;

export type MemoryType = "user" | "feedback" | "project" | "reference";
export const MEMORY_TYPES: readonly MemoryType[] = ["user", "feedback", "project", "reference"];

export interface MemoryConfig {
	/** Override the personal memory root (default: ~/.pi/agent/memory). */
	memoryDir?: string;
	/** Project-local shared memory (<cwd>/.pi/memory) read/written by the agent. */
	sharedMemory: boolean;
	/** Background extraction after the agent settles. */
	autoExtract: boolean;
	/** Minimum new session messages before auto-extraction runs. */
	autoExtractMinMessages: number;
	/** Recall injection on each user prompt. */
	recall: boolean;
	/** Wrap cited sentences in <cc-memory> tags (Claude Code's citing experiment). */
	citeMemories: boolean;
}

const DEFAULTS: MemoryConfig = {
	sharedMemory: false,
	autoExtract: true,
	autoExtractMinMessages: 1,
	recall: true,
	citeMemories: false,
};

/** Claude Code's so(): slugify a project path for use as a directory name. */
export function projectSlug(cwd: string): string {
	const base = path.basename(cwd).replace(/[^a-zA-Z0-9\-_]/g, "-");
	return base === "" ? "unknown" : base;
}

export interface MemoryPaths {
	personalDir: string;
	teamDir: string | null;
	configFile: string;
}

export function resolvePaths(cwd: string, config: MemoryConfig): MemoryPaths {
	// path.resolve anchors relative memoryDir values against the CURRENT cwd —
	// without it a relative config would silently follow the process wherever
	// it wanders. Trailing separators are normalized by resolve as well.
	const root = config.memoryDir
		? path.resolve(expandHome(config.memoryDir))
		: path.join(os.homedir(), ".pi", "agent", "memory");
	return {
		personalDir: path.join(root, projectSlug(cwd)),
		teamDir: config.sharedMemory ? path.join(cwd, ".pi", "memory") : null,
		configFile: path.join(root, "config.json"),
	};
}

export function expandHome(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
	return p;
}

export function loadConfig(cwd: string): MemoryConfig {
	const config: MemoryConfig = { ...DEFAULTS };
	// Merge from ~/.pi/agent/memory/config.json, then <cwd>/.pi/memory.json.
	// PI_MEMORY_DIR overrides the memory root from files (env wins, standard
	// precedence) — also what makes the extension testable without touching
	// the user's real home directory.
	const candidates = [
		path.join(os.homedir(), ".pi", "agent", "memory", "config.json"),
		path.join(cwd, ".pi", "memory.json"),
	];
	for (const file of candidates) {
		try {
			const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<MemoryConfig>;
			if (typeof raw.memoryDir === "string") config.memoryDir = raw.memoryDir;
			if (typeof raw.sharedMemory === "boolean") config.sharedMemory = raw.sharedMemory;
			if (typeof raw.autoExtract === "boolean") config.autoExtract = raw.autoExtract;
			if (typeof raw.autoExtractMinMessages === "number")
				config.autoExtractMinMessages = Math.max(1, Math.floor(raw.autoExtractMinMessages));
			if (typeof raw.recall === "boolean") config.recall = raw.recall;
			if (typeof raw.citeMemories === "boolean") config.citeMemories = raw.citeMemories;
		} catch {
			// missing or unparsable file: keep defaults
		}
	}
	if (process.env.PI_MEMORY_DIR?.trim()) config.memoryDir = process.env.PI_MEMORY_DIR.trim();
	return config;
}

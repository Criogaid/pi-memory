/**
 * pi-memory configuration: project identity, directory layout, and persisted flags.
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
import { createHash } from "node:crypto";

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
	/** Persisted project switch; branch-local pause is separate. */
	enabled: boolean;
	/** Opt-in consolidation after settled foreground work. */
	autoDream: boolean;
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

export type MemorySwitches = { [Key in keyof MemoryConfig as MemoryConfig[Key] extends boolean ? Key : never]: MemoryConfig[Key] };
export type MemorySwitchKey = keyof MemorySwitches;

/** Shared settings metadata for command completion, parsing, and the native settings list. */
export const MEMORY_SWITCHES = [
	{ key: "enabled", command: "", label: "Memory", description: "Enable memory for this project. Turning it off keeps the feature settings below." },
	{ key: "autoExtract", command: "auto-extract", label: "Automatic extraction", description: "Save durable facts after a conversation turn. Requires Memory on and this branch unpaused." },
	{ key: "autoDream", command: "auto-dream", label: "Automatic Dream", description: "Consolidate memories when enough new sessions and time have accumulated. Requires Memory on and this branch unpaused." },
	{ key: "recall", command: "recall", label: "Recall", description: "Add relevant memory bodies to new prompts. The session index and pinned memories remain available." },
	{ key: "sharedMemory", command: "shared-memory", label: "Shared memory", description: "Read and write team memories in this project's .pi/memory directory. Turning it off preserves existing files." },
	{ key: "citeMemories", command: "cite-memories", label: "Memory citations", description: "Ask the model to mark memory-backed statements. Takes effect on the next prompt." },
] as const satisfies readonly { key: MemorySwitchKey; command: string; label: string; description: string }[];

// Keep README.md Configuration defaults aligned with this object.
const DEFAULTS: MemoryConfig = {
	enabled: true,
	autoDream: false,
	sharedMemory: false,
	autoExtract: true,
	autoExtractMinMessages: 1,
	recall: true,
	citeMemories: false,
};

/** The full canonical path owns identity; the basename is only a readable prefix. */
export function projectSlug(cwd: string): string {
	let canonical = path.resolve(cwd);
	try { canonical = fs.realpathSync.native(canonical); } catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
	if (process.platform === "win32") canonical = canonical.toLowerCase();
	const maxLabelChars = 48;
	const label = (path.basename(canonical).replace(/[^a-zA-Z0-9\-_]/g, "-") || "unknown").slice(0, maxLabelChars);
	return `${label}-${createHash("sha256").update(canonical).digest("hex")}`;
}

/** Legacy directories may contain several projects' data, so migration is explicit. */
export function legacyMemoryDir(cwd: string, paths: MemoryPaths): string {
	return path.join(path.dirname(paths.personalDir), path.basename(cwd).replace(/[^a-zA-Z0-9\-_]/g, "-") || "unknown");
}

export interface MemoryPaths {
	personalDir: string;
	teamDir: string | null;
}

export function resolvePaths(cwd: string, config: MemoryConfig): MemoryPaths {
	// path.resolve anchors relative memoryDir values against the CURRENT cwd —
	// without it a relative config would silently follow the process wherever
	// it wanders. Trailing separators are normalized by resolve as well.
	const root = config.memoryDir
		? path.resolve(cwd, expandHome(config.memoryDir))
		: path.join(os.homedir(), ".pi", "agent", "memory");
	return {
		personalDir: path.join(root, projectSlug(cwd)),
		teamDir: config.sharedMemory ? path.join(cwd, ".pi", "memory") : null,
	};
}

export function expandHome(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
	return p;
}

export function projectConfigFile(cwd: string): string {
	return path.join(cwd, ".pi", "memory.json");
}

export function loadConfig(cwd: string): MemoryConfig {
	const config: MemoryConfig = { ...DEFAULTS };
	// Merge from ~/.pi/agent/memory/config.json, then <cwd>/.pi/memory.json.
	// PI_MEMORY_DIR overrides the memory root from files (env wins, standard
	// precedence) — also what makes the extension testable without touching
	// the user's real home directory.
	const candidates = [
		path.join(os.homedir(), ".pi", "agent", "memory", "config.json"),
		projectConfigFile(cwd),
	];
	for (const file of candidates) {
		try {
			const raw: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
			if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
			if ("enabled" in raw && typeof raw.enabled === "boolean") config.enabled = raw.enabled;
			if ("autoDream" in raw && typeof raw.autoDream === "boolean") config.autoDream = raw.autoDream;
			if ("memoryDir" in raw && typeof raw.memoryDir === "string") config.memoryDir = raw.memoryDir;
			if ("sharedMemory" in raw && typeof raw.sharedMemory === "boolean") config.sharedMemory = raw.sharedMemory;
			if ("autoExtract" in raw && typeof raw.autoExtract === "boolean") config.autoExtract = raw.autoExtract;
			if ("autoExtractMinMessages" in raw && typeof raw.autoExtractMinMessages === "number" && Number.isFinite(raw.autoExtractMinMessages))
				config.autoExtractMinMessages = Math.max(1, Math.floor(raw.autoExtractMinMessages));
			if ("recall" in raw && typeof raw.recall === "boolean") config.recall = raw.recall;
			if ("citeMemories" in raw && typeof raw.citeMemories === "boolean") config.citeMemories = raw.citeMemories;
		} catch {
			// missing or unparsable file: keep defaults
		}
	}
	if (process.env.PI_MEMORY_DIR?.trim()) config.memoryDir = process.env.PI_MEMORY_DIR.trim();
	return config;
}

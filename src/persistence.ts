/** Plugin state persistence. Pi exposes file queues but no general cross-process
 * lock; use the same lock library as its settings store, behind this adapter.
 * Lock order is pi's per-file queue, then the cross-process lock. Dream takes
 * only its state lock; it never holds a settings queue while updating memory.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { lock } from "proper-lockfile";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { projectConfigFile, type MemoryConfig } from "./config.js";
import { writeFileSafe } from "./store.js";

export type LockedResult<T> = { readonly kind: "busy" } | { readonly kind: "done"; readonly value: T };

export async function withStateLock<T>(file: string, signal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<LockedResult<T>> {
	const controller = new AbortController();
	const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
	combined.throwIfAborted();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	let release: () => Promise<void>;
	try {
		release = await lock(file, { realpath: false, onCompromised: (error) => controller.abort(error) });
	} catch (error) {
		if (isFileError(error, "ELOCKED")) return { kind: "busy" };
		throw error;
	}
	try {
		combined.throwIfAborted();
		return { kind: "done", value: await work(combined) };
	} finally {
		// A compromised lock is already released by proper-lockfile.
		if (!controller.signal.aborted) await release();
	}
}

export function isFileError(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

export type MemorySwitches = Pick<MemoryConfig, "enabled" | "autoExtract" | "autoDream">;

/** Preserve unknown configuration fields; malformed existing files are never overwritten. */
export async function saveMemorySwitches(cwd: string, changes: Partial<MemorySwitches>): Promise<void> {
	const file = projectConfigFile(cwd);
	await withFileMutationQueue(file, async () => {
		const result = await withStateLock(file, undefined, async (signal) => {
			let raw: unknown = {};
			try { raw = JSON.parse(fs.readFileSync(file, "utf-8")); }
			catch (error) { if (!isFileError(error, "ENOENT")) throw new Error(`Could not read memory settings: ${file}`, { cause: error }); }
			if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`Configuration must be an object: ${file}`);
			signal.throwIfAborted();
			writeFileSafe(file, JSON.stringify({ ...raw, ...changes }, null, 2) + "\n");
		});
		if (result.kind === "busy") throw new Error(`Configuration is being updated by another process: ${file}`);
	});
}

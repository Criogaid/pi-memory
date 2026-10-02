/** Dream policy and lifecycle. Pi owns session parsing/context reconstruction;
 * MemoryJobs owns model execution and memory mutations. The state lock covers
 * eligibility, attempt recording, and completion across processes. Only complete
 * runs advance the watermark; partial writes remain visible and are retried.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager, convertToLlm, serializeConversation, sessionEntryToContextMessages, truncateTail, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { JobModelSelection, MemoryPaths } from "./config.js";
import { buildDreamPrompt } from "./extract.js";
import { isFileError, withStateLock } from "./persistence.js";
import { writeFileSafe } from "./store.js";
import { awaitWithAbort, MemoryJobs, type MemoryJobResult } from "./workflow.js";

// Keep README.md Behavior and guarantees aligned with these policy bounds.
const MIN_INTERVAL_MS = 24 * 60 * 60_000;
const RETRY_INTERVAL_MS = 10 * 60_000;
const MIN_NEW_SESSIONS = 5;
const MAX_SESSION_EXCERPTS = 5;
const MAX_EXCERPT_BYTES = 8_000;
const MAX_EXCERPT_LINES = 300;
const RUN_TIMEOUT_MS = 70_000;
const STATE_FILE = ".dream-state.json";

export interface DreamState {
	readonly version: 1;
	readonly lastAttemptAt: number | null;
	readonly lastCompletedAt: number | null;
	readonly through: number;
}

export function readDreamState(paths: MemoryPaths): DreamState {
	const file = path.join(paths.personalDir, STATE_FILE);
	let value: unknown;
	try { value = JSON.parse(fs.readFileSync(file, "utf8")); }
	catch (error) {
		if (isFileError(error, "ENOENT")) return { version: 1, lastAttemptAt: null, lastCompletedAt: null, through: 0 };
		throw new Error(`Could not read Dream state: ${file}`, { cause: error });
	}
	if (typeof value !== "object" || value === null || !("version" in value) || value.version !== 1 ||
		!("lastAttemptAt" in value) || !optionalTimestamp(value.lastAttemptAt) ||
		!("lastCompletedAt" in value) || !optionalTimestamp(value.lastCompletedAt) ||
		!("through" in value) || !timestamp(value.through)) throw new Error(`Invalid Dream state: ${file}`);
	return { version: value.version, lastAttemptAt: value.lastAttemptAt, lastCompletedAt: value.lastCompletedAt, through: value.through };
}

function timestamp(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function optionalTimestamp(value: unknown): value is number | null { return value === null || timestamp(value); }

export type DreamResult = MemoryJobResult | { readonly status: "skipped"; readonly reason: string };
export interface DreamRequest {
	readonly automatic: boolean;
	readonly paths: MemoryPaths;
	readonly sessionId: string;
	readonly systemPrompt: string;
	readonly model?: JobModelSelection;
}

export class DreamRunner {
	private active: AbortController | undefined;
	constructor(private readonly jobs: MemoryJobs) {}

	cancel(): void { this.active?.abort(new Error("Dream cancelled")); }

	async run(ctx: ExtensionContext, request: DreamRequest): Promise<DreamResult> {
		if (this.active) return { status: "busy", written: [], applied: 0, errors: [] };
		const controller = new AbortController();
		this.active = controller;
		const signal = ctx.signal ? AbortSignal.any([controller.signal, ctx.signal]) : controller.signal;
		const timer = setTimeout(() => controller.abort(new Error("Dream timed out")), RUN_TIMEOUT_MS);
		// Preserve applied operations if recording completion fails after model work.
		let applied: MemoryJobResult | undefined;
		try {
			const file = path.join(request.paths.personalDir, STATE_FILE);
			const locked = await withStateLock(file, signal, async (lockedSignal): Promise<DreamResult> => {
				const state = readDreamState(request.paths);
				const startedAt = Date.now();
				if (request.automatic) {
					if (state.lastAttemptAt !== null && startedAt - state.lastAttemptAt < RETRY_INTERVAL_MS) return { status: "skipped", reason: "retry interval" };
					if (state.lastCompletedAt !== null && startedAt - state.lastCompletedAt < MIN_INTERVAL_MS) return { status: "skipped", reason: "completion interval" };
				}
				const sessions = await awaitWithAbort(SessionManager.list(ctx.cwd, ctx.sessionManager.getSessionDir()), lockedSignal);
				lockedSignal.throwIfAborted();
				const activeId = ctx.sessionManager.getSessionId();
				const recent = sessions.filter((session) => session.id !== activeId && session.modified.getTime() > state.through)
					.sort((a, b) => b.modified.getTime() - a.modified.getTime() || a.id.localeCompare(b.id, "en"));
				const activeIsNew = ctx.sessionManager.getBranch().some((entry) => entry.type === "message" && Date.parse(entry.timestamp) > state.through);
				if (request.automatic && recent.length + Number(activeIsNew) < MIN_NEW_SESSIONS) return { status: "skipped", reason: "new session threshold" };
				const excerpts = [sessionExcerpt(ctx.sessionManager)];
				for (const session of recent.slice(0, MAX_SESSION_EXCERPTS - 1)) {
					lockedSignal.throwIfAborted();
					excerpts.push(sessionExcerpt(SessionManager.open(session.path, ctx.sessionManager.getSessionDir(), ctx.cwd)));
				}
				const omitted = Math.max(0, recent.length - (MAX_SESSION_EXCERPTS - 1));
				const attempt: DreamState = { ...state, lastAttemptAt: startedAt };
				lockedSignal.throwIfAborted();
				writeFileSafe(file, JSON.stringify(attempt) + "\n");
				applied = await this.jobs.run(ctx, {
					kind: "dream", paths: request.paths, sessionId: request.sessionId, systemPrompt: request.systemPrompt, model: request.model,
					prompt: buildDreamPrompt(request.paths, excerpts.join("\n\n") + (omitted ? `\n${omitted} older sessions omitted from this bounded sample.` : "")), signal: lockedSignal,
				});
				lockedSignal.throwIfAborted();
				if (applied.status === "completed") {
					// A run's end may follow newer foreground writes in another process.
					// Advance only to its start so those sessions remain candidates.
					const completed: DreamState = { ...attempt, lastCompletedAt: Date.now(), through: startedAt };
					writeFileSafe(file, JSON.stringify(completed) + "\n");
				}
				return applied;
			});
			return locked.kind === "busy" ? { status: "busy", written: [], applied: 0, errors: [] } : locked.value;
		} catch (error) {
			return {
				status: applied?.applied ? "partial" : signal.aborted ? "cancelled" : "failed",
				written: applied?.written ?? [], applied: applied?.applied ?? 0,
				errors: [...(applied?.errors ?? []), error instanceof Error ? error.message : String(error)],
				notices: applied?.notices,
			};
		} finally {
			clearTimeout(timer);
			if (this.active === controller) this.active = undefined;
		}
	}
}

function sessionExcerpt(manager: ExtensionContext["sessionManager"]): string {
	const messages = manager.buildContextEntries().flatMap(sessionEntryToContextMessages);
	const result = truncateTail(serializeConversation(convertToLlm(messages)), { maxBytes: MAX_EXCERPT_BYTES, maxLines: MAX_EXCERPT_LINES });
	return `Session ${manager.getSessionId()}${result.truncated ? " (older context omitted)" : ""}\n${result.content}`;
}

/** Bounded memory-only model jobs. pi owns model/auth routing and file queues.
 * No public pi fork API enforces this operation protocol and its read-before-write
 * contract, so this module owns the small turn loop and cancellation boundary.
 */
import { uuidv7, type Message } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { LIMITS, type MemoryPaths } from "./config.js";
import { applyExtractOps, parseExtractResponse } from "./extract.js";
import { isValidFileRef, memoryPath, readFileOrNull } from "./store.js";

const MAX_TURNS = 5;
const MAX_CONTEXT_BYTES = 160_000;
const MAX_READ_BYTES = 32_000;
const MAX_OUTPUT_TOKENS = 4096;
const MAX_RESPONSE_BYTES = 32_000;
const TIMEOUT_MS = 60_000;

export interface MemoryJobRequest {
	readonly kind: "extract" | "dream";
	readonly paths: MemoryPaths;
	readonly sessionId: string;
	readonly systemPrompt: string;
	readonly prompt: string;
}

export interface MemoryJobResult {
	readonly status: "completed" | "partial" | "cancelled" | "failed" | "busy";
	readonly written: readonly string[];
	readonly applied: number;
	readonly errors: readonly string[];
}

/** One active memory job per extension instance; cancellation prevents queued effects. */
export class MemoryJobs {
	private active: AbortController | undefined;

	cancel(): void { this.active?.abort(new Error("Memory job cancelled")); }

	async run(ctx: ExtensionContext, request: MemoryJobRequest): Promise<MemoryJobResult> {
		if (this.active) return { status: "busy", written: [], applied: 0, errors: [] };
		const controller = new AbortController();
		this.active = controller;
		const signal = ctx.signal ? AbortSignal.any([controller.signal, ctx.signal]) : controller.signal;
		const timeout = setTimeout(() => controller.abort(new Error("Memory job timed out")), TIMEOUT_MS);
		try {
			return await execute(ctx, request, signal);
		} catch (error) {
			return {
				status: signal.aborted ? "cancelled" : "failed", written: [], applied: 0,
				errors: [error instanceof Error ? error.message : String(error)],
			};
		} finally {
			clearTimeout(timeout);
			if (this.active === controller) this.active = undefined;
		}
	}
}

async function execute(ctx: ExtensionContext, request: MemoryJobRequest, signal: AbortSignal): Promise<MemoryJobResult> {
	if (!ctx.model) throw new Error("No active model for the memory job");
	const observations = new Map<string, string | null>();
	const modelSessionId = uuidv7();
	const messages: Message[] = [{ role: "user", content: request.prompt, timestamp: Date.now() }];
	const systemPrompt = request.systemPrompt +
		`\n\nThis is a restricted memory job. Return only JSON, either {"read":["memory.md"]} or {"ops":[...]}. ` +
		`Use at most ${LIMITS.extractMaxOps} reads or operations per response. Reads return complete files; oversized files cannot be edited. ` +
		"Read existing files before changing them. Omit pinned to preserve its current value. Never run commands or write source files. " +
		(request.kind === "dream" ? "Do not create team memories or promote personal content into team memory. " : "");
	for (let turn = 0; turn < MAX_TURNS; turn++) {
		signal.throwIfAborted();
		if (Buffer.byteLength(systemPrompt + JSON.stringify(messages), "utf8") > MAX_CONTEXT_BYTES)
			throw new Error("Memory job context exceeds its bound; no further operations were applied");
		const response = await abortable(ctx.modelRegistry.complete(ctx.model, { systemPrompt, messages }, {
			signal, maxTokens: MAX_OUTPUT_TOKENS, sessionId: modelSessionId, cacheRetention: "none",
		}), signal);
		signal.throwIfAborted();
		if (response.stopReason === "error" || response.stopReason === "aborted")
			throw new Error("Memory model did not complete its response");
		const text = response.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
		if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw new Error("Memory response exceeds its byte bound");
		const reply = parseExtractResponse(text);
		if (!reply) throw new Error("Memory model returned an invalid operation response");
		messages.push(response);
		if (reply.kind === "read") {
			if (!reply.files.length || reply.files.length > LIMITS.extractMaxOps) throw new Error("Memory read request exceeds its file bound");
			const files = reply.files.map((ref) => {
				if (!isValidFileRef(ref, request.paths.teamDir !== null)) throw new Error(`Invalid memory reference: ${ref}`);
				const content = readFileOrNull(memoryPath(request.paths, ref));
				if (content !== null && Buffer.byteLength(content, "utf8") > MAX_READ_BYTES)
					return { ref, error: "File exceeds the complete-read bound; do not modify it" };
				observations.set(ref, content);
				return { ref, content };
			});
			messages.push({ role: "user", content: JSON.stringify({ files }), timestamp: Date.now() });
			continue;
		}
		if (reply.ops.length > LIMITS.extractMaxOps) throw new Error("Memory operation response exceeds its operation bound");
		const missing: string[] = [];
		for (const op of reply.ops) {
			if (typeof op !== "object" || op === null || !("file" in op) || typeof op.file !== "string" || !isValidFileRef(op.file, request.paths.teamDir !== null))
				throw new Error("Memory operation requires a valid file reference");
			if (!observations.has(op.file)) {
				const content = readFileOrNull(memoryPath(request.paths, op.file));
				if (content === null) observations.set(op.file, null);
				else missing.push(op.file);
			}
			if (request.kind === "dream" && op.file.startsWith("team/") && observations.get(op.file) === null)
				throw new Error("Dream cannot create or promote team memories");
		}
		if (missing.length) {
			messages.push({ role: "user", content: JSON.stringify({ readRequired: missing }), timestamp: Date.now() });
			continue;
		}
		const result = await applyExtractOps(request.paths, reply.ops, request.sessionId, { observations, signal });
		return { status: result.skipped.length ? "partial" : "completed", written: result.written, applied: result.applied, errors: result.skipped };
	}
	throw new Error("Memory job reached its turn limit without completing operations");
}

/** Bound caller wait even when a provider ignores AbortSignal; late output is discarded. */
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
		operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

/** Bounded memory-only model jobs. pi owns model/auth routing and file queues.
 * No public pi fork API enforces this operation protocol and its read-before-write
 * contract, so this module owns the small turn loop and cancellation boundary.
 */
import { uuidv7, type Message } from "@earendil-works/pi-ai";
import * as fs from "node:fs";
import * as path from "node:path";
import { createReadTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { LIMITS, type MemoryPaths } from "./config.js";
import { applyExtractOps, parseExtractResponse } from "./extract.js";
import { containsPath, isValidFileRef, memoryPath, readFileOrNull } from "./store.js";

// Keep README.md Behavior and guarantees aligned with these execution bounds.
const MAX_TURNS = 5;
const MAX_CONTEXT_BYTES = 160_000;
const MAX_READ_BYTES = 32_000;
const MAX_OUTPUT_TOKENS = 4096;
const MAX_RESPONSE_BYTES = 32_000;
const TIMEOUT_MS = 60_000;
const MAX_PROJECT_FILE_BYTES = 1_000_000;

export interface MemoryJobRequest {
	readonly kind: "extract" | "dream";
	readonly paths: MemoryPaths;
	readonly sessionId: string;
	readonly systemPrompt: string;
	readonly prompt: string;
	readonly signal?: AbortSignal;
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
		const signals = [controller.signal];
		if (ctx.signal) signals.push(ctx.signal);
		if (request.signal) signals.push(request.signal);
		const signal = AbortSignal.any(signals);
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
		`Use at most ${LIMITS.extractMaxOps} reads or operations per response. Memory reads return complete files; oversized memories cannot be edited. Project reads use Pi's output truncation. ` +
		"Read existing files before changing them. Omit pinned to preserve its current value. Never run commands or write source files. " +
		(request.kind === "dream" ? 'You may also request {"readProject":["relative/path"]} to inspect current source. Do not create team memories or promote personal content into team memory. ' : "");
	for (let turn = 0; turn < MAX_TURNS; turn++) {
		signal.throwIfAborted();
		if (Buffer.byteLength(systemPrompt + JSON.stringify(messages), "utf8") > MAX_CONTEXT_BYTES)
			throw new Error("Memory job context exceeds its bound; no further operations were applied");
		const response = await awaitWithAbort(ctx.modelRegistry.complete(ctx.model, { systemPrompt, messages }, {
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
		if (reply.kind === "readProject") {
			if (request.kind !== "dream") throw new Error("Project reads are only available during Dream");
			if (!reply.files.length || reply.files.length > LIMITS.extractMaxOps) throw new Error("Project read request exceeds its file bound");
			const root = fs.realpathSync(ctx.cwd);
			const reader = createReadTool(root);
			const files: ({ path: string; content: string } | { path: string; error: string })[] = [];
			for (const file of reply.files) {
				signal.throwIfAborted();
				files.push({ path: file, ...await readProjectFile(root, reader, file, signal) });
			}
			messages.push({ role: "user", content: JSON.stringify({ files }), timestamp: Date.now() });
			continue;
		}
		if (reply.kind === "read") {
			if (!reply.files.length || reply.files.length > LIMITS.extractMaxOps) throw new Error("Memory read request exceeds its file bound");
			// Unreadable references stay unobserved, so later operations on them are still refused.
			const files = reply.files.map((ref) => {
				if (!isValidFileRef(ref, request.paths.teamDir !== null)) return { ref, error: "Invalid memory reference; use a listed lowercase .md file" };
				let target: string;
				try { target = memoryPath(request.paths, ref); }
				catch (error) { return { ref, error: error instanceof Error ? error.message : String(error) }; }
				const content = readFileOrNull(target);
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

/** Containment violations end the job; unreadable in-project targets are reported so one bad guess does not. */
async function readProjectFile(root: string, reader: ReturnType<typeof createReadTool>, file: string, signal: AbortSignal): Promise<{ content: string } | { error: string }> {
	if (path.isAbsolute(file)) throw new Error("Project reads require relative paths");
	let absolute: string;
	try { absolute = fs.realpathSync(path.resolve(root, file)); }
	catch (error) {
		if (!isMissingPath(error)) throw error;
		if (!missingPathStaysInside(root, path.resolve(root, file))) throw new Error("Project read is outside the current project");
		return { error: "File not found in the current project" };
	}
	if (!containsPath(root, absolute)) throw new Error("Project read is outside the current project");
	const stat = fs.statSync(absolute);
	if (!stat.isFile() || stat.size > MAX_PROJECT_FILE_BYTES) return { error: "Project read requires a regular file within the byte bound" };
	const result = await awaitWithAbort(reader.execute(uuidv7(), { path: absolute }, signal), signal);
	if (result.content.some((part) => part.type !== "text")) return { error: "Project reads require text files" };
	return { content: result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") };
}

/**
 * realpath cannot resolve a path through a dangling link, so follow existing components and
 * links by hand: a missing path counts as inside only if every hop it takes stays in the root.
 */
function missingPathStaysInside(root: string, lexical: string): boolean {
	if (!containsPath(root, lexical)) return false;
	const pending = path.relative(root, lexical).split(path.sep).filter(Boolean);
	let current = root;
	for (let hops = 0; pending.length > 0;) {
		const next = path.join(current, pending.shift() as string);
		let entry: fs.Stats;
		try { entry = fs.lstatSync(next); }
		catch (error) { if (isMissingPath(error)) return true; throw error; }
		if (!entry.isSymbolicLink()) { current = next; continue; }
		if (++hops > 40) return false;
		const target = path.resolve(current, fs.readlinkSync(next));
		if (!containsPath(root, target)) return false;
		// Re-walk the link target from the root so links inside it are checked too.
		pending.unshift(...path.relative(root, target).split(path.sep).filter(Boolean));
		current = root;
	}
	return true;
}

function isMissingPath(error: unknown): boolean {
	return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

/** Bound caller wait even when a provider ignores AbortSignal; late output is discarded. */
export function awaitWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
		operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

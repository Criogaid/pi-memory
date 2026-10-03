/** Bounded memory-only model jobs. pi owns model/auth routing and file queues.
 * No public pi fork API enforces this operation protocol and its read-before-write
 * contract, so this module owns the small turn loop and cancellation boundary.
 */
import { clampThinkingLevel, getSupportedThinkingLevels, uuidv7, type Api, type AssistantMessage, type Message, type Model, type ModelThinkingLevel, type ThinkingBudgets } from "@earendil-works/pi-ai";
import * as fs from "node:fs";
import * as path from "node:path";
import { convertToLlm, createReadTool, type ContextWithSystemEvent, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatJobModel, LIMITS, type JobModelSelection, type MemoryPaths } from "./config.js";
import { applyExtractOps, parseExtractResponse, type JobPrompt } from "./extract.js";
import { containsPath, isValidFileRef, memoryPath, readFileOrNull } from "./store.js";

// Keep README.md Behavior and guarantees aligned with these execution bounds.
const MAX_TURNS = 5;
const MAX_CONTEXT_BYTES = 160_000;
const MAX_READ_BYTES = 32_000;
const MAX_RESPONSE_BYTES = 32_000;
const TIMEOUT_MS = 60_000;
const MAX_PROJECT_FILE_BYTES = 1_000_000;

type AgentMessages = ContextWithSystemEvent["messages"];

/** Request options that pi's agent sends with every foreground call and that affect provider caching. */
export interface ForegroundRequestOptions {
	readonly sessionId: string;
	readonly thinkingBudgets?: ThinkingBudgets;
}

/** The last foreground request as the provider received it, followed by the reply that ended the run. */
export interface ForegroundFork {
	readonly messages: readonly Message[];
	readonly reply: AssistantMessage;
	readonly options: ForegroundRequestOptions;
}

/**
 * Tracks the context of the latest foreground model request so an extraction on the same model
 * can resend it unchanged and read it from the provider's prompt cache. Pi exposes the request
 * only through `context_with_system`; any later message other than its reply makes the capture stale.
 */
export class ForegroundPrefix {
	private request: AgentMessages | undefined;
	private reply: AssistantMessage | undefined;

	reset(): void { this.request = undefined; this.reply = undefined; }

	observeRequest(messages: AgentMessages): void { this.request = messages; this.reply = undefined; }

	observeMessage(message: AgentMessages[number]): void {
		if (!this.request) return;
		if (message.role === "assistant" && this.reply === undefined) this.reply = message;
		else this.reset();
	}

	/**
	 * Only a run that ended on a final reply leaves a reusable prefix. Pi rewrites images when they
	 * are blocked; that conversion is not public, so such contexts are not reproduced.
	 */
	fork(options: ForegroundRequestOptions, blockImages: boolean): ForegroundFork | undefined {
		const { request, reply } = this;
		if (!request || !reply || reply.stopReason !== "stop" || reply.content.some((part) => part.type === "toolCall")) return undefined;
		const messages = convertToLlm(request);
		if (blockImages && messages.some((message) => message.role !== "system" && message.role !== "assistant" && Array.isArray(message.content) && message.content.some((part) => part.type === "image")))
			return undefined;
		return { messages: [...messages, reply], reply, options };
	}
}

export interface MemoryJobRequest {
	readonly kind: "extract" | "dream";
	readonly paths: MemoryPaths;
	readonly sessionId: string;
	/** Stable job prefix; the restricted protocol and `prompt.instructions` are appended to it. */
	readonly systemPrompt: string;
	readonly prompt: JobPrompt;
	/**
	 * The foreground prefix and the per-run input to append to it. Used instead of `systemPrompt`
	 * and `prompt.input` when the job runs on the model and thinking level that produced the reply.
	 */
	readonly fork?: { readonly prefix: ForegroundFork; readonly input: string };
	readonly signal?: AbortSignal;
	/** Configured job model; absent uses the session model and its thinking level. */
	readonly model?: JobModelSelection;
	/** The session's thinking level when the job starts; jobs without an explicit level follow it. */
	readonly sessionThinkingLevel: ModelThinkingLevel;
}

export interface MemoryJobResult {
	readonly status: "completed" | "partial" | "cancelled" | "failed" | "busy";
	readonly written: readonly string[];
	readonly applied: number;
	readonly errors: readonly string[];
	/** Configuration problems that did not stop the job, such as a fallback to the session model. */
	readonly notices?: readonly string[];
}

interface ResolvedJobModel {
	readonly model: Model<Api> | undefined;
	readonly thinking: ModelThinkingLevel;
	readonly notices: readonly string[];
}

/**
 * Jobs request models the way pi's agent does, so whatever runs in the chat also runs here,
 * including virtual models that only `streamSimple` routes. An unusable selection falls back
 * to the session model and reports why, so a typo cannot stop memory jobs.
 */
function resolveJobModel(ctx: ExtensionContext, selection: JobModelSelection | undefined, sessionThinking: ModelThinkingLevel): ResolvedJobModel {
	if (!selection) return { model: ctx.model, thinking: sessionThinking, notices: [] };
	const configured = ctx.modelRegistry.find(selection.provider, selection.model);
	if (!configured || !ctx.modelRegistry.hasConfiguredAuth(configured)) {
		const reason = configured ? "has no configured credentials" : "is not a known model";
		return { model: ctx.model, thinking: sessionThinking, notices: [`Configured model ${formatJobModel(selection)} ${reason}; used the session model`] };
	}
	// pi clamps the session level to the session model; a different job model needs its own clamp.
	const followed = clampThinkingLevel(configured, sessionThinking);
	if (selection.thinkingLevel === undefined) return { model: configured, thinking: followed, notices: [] };
	const level = getSupportedThinkingLevels(configured).find((candidate) => candidate === selection.thinkingLevel);
	if (level === undefined) {
		return { model: configured, thinking: followed, notices: [`Thinking level ${selection.thinkingLevel} is not supported by ${configured.provider}/${configured.id}; followed the session thinking level`] };
	}
	return { model: configured, thinking: level, notices: [] };
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
		const resolved = resolveJobModel(ctx, request.model, request.sessionThinkingLevel);
		try {
			return { ...await execute(ctx, request, signal, resolved), notices: resolved.notices };
		} catch (error) {
			return {
				status: signal.aborted ? "cancelled" : "failed", written: [], applied: 0,
				errors: [error instanceof Error ? error.message : String(error)], notices: resolved.notices,
			};
		} finally {
			clearTimeout(timeout);
			if (this.active === controller) this.active = undefined;
		}
	}
}

async function execute(ctx: ExtensionContext, request: MemoryJobRequest, signal: AbortSignal, resolved: ResolvedJobModel): Promise<MemoryJobResult> {
	const { model, thinking } = resolved;
	if (!model) throw new Error("No active model for the memory job");
	const observations = new Map<string, string | null>();
	const protocol = `This is a restricted memory job. Return only JSON, either {"read":["memory.md"]} or {"ops":[...]}. ` +
		`Use at most ${LIMITS.extractMaxOps} reads or operations per response. Memory reads return complete files; oversized memories cannot be edited. Project reads use Pi's output truncation. ` +
		"Read existing files before changing them. Omit pinned to preserve its current value. Never run commands or write source files. " +
		(request.kind === "dream" ? 'You may also request {"readProject":["relative/path"]} to inspect current source. Do not create team memories or promote personal content into team memory. ' : "");
	const fork = request.fork && forksForeground(request.fork.prefix, model, thinking) ? request.fork : undefined;
	// A fork resends the foreground request byte for byte with pi's request options, so the provider
	// serves it from the foreground cache; job instructions follow it in one appended user message.
	// Otherwise repeated jobs share a compact system prefix under a stable per-session, per-kind key
	// that stays distinct from the foreground key, and per-run content follows that prefix.
	const prefix: readonly Message[] = fork?.prefix.messages ?? [];
	const systemPrompt = fork ? undefined : `${request.systemPrompt}\n\n${protocol}\n\n${request.prompt.instructions}`;
	const messages: Message[] = [{
		role: "user", timestamp: Date.now(),
		content: fork ? `${protocol}\n\n${request.prompt.instructions}\n\n${fork.input}` : request.prompt.input,
	}];
	const options = fork
		// pi-ai keeps Codex WebSocket continuation per session key; SSE leaves the foreground's intact.
		? { sessionId: fork.prefix.options.sessionId, thinkingBudgets: fork.prefix.options.thinkingBudgets, transport: "sse" as const }
		: { sessionId: `pi-memory-${request.kind}:${request.sessionId}` };
	for (let turn = 0; turn < MAX_TURNS; turn++) {
		signal.throwIfAborted();
		// The inherited prefix fit the foreground request; the bound covers what the job adds.
		if (Buffer.byteLength((systemPrompt ?? "") + JSON.stringify(messages), "utf8") > MAX_CONTEXT_BYTES)
			throw new Error("Memory job context exceeds its bound; no further operations were applied");
		// Pi's own agent maps "off" to an omitted reasoning option. An omitted maxTokens lets pi-ai use the
		// model's output limit, as Claude Code does for its memory agents: thinking tokens count against that
		// limit on most providers, so a small fixed cap would truncate reasoning replies. MAX_TURNS bounds cost.
		const response = await awaitWithAbort(ctx.modelRegistry.streamSimple(model, { systemPrompt, messages: [...prefix, ...messages] }, {
			...options, signal, reasoning: thinking === "off" ? undefined : thinking,
		}).result(), signal);
		signal.throwIfAborted();
		if (response.stopReason === "error" || response.stopReason === "aborted")
			throw new Error("Memory model did not complete its response");
		if (response.stopReason === "length")
			throw new Error("Memory model response hit its output token limit; no operations from it were applied");
		// A fork keeps the foreground tool declarations, because changing them or tool_choice would
		// invalidate the cached prefix. Answer any tool call with an error so the transcript stays valid.
		const calls = response.content.filter((part) => part.type === "toolCall");
		if (calls.length > 0) {
			messages.push(response);
			for (const call of calls) {
				messages.push({
					role: "toolResult", toolCallId: call.id, toolName: call.name, isError: true, timestamp: Date.now(),
					content: [{ type: "text", text: "Tools are unavailable in this memory job. Reply with the JSON protocol only." }],
				});
			}
			continue;
		}
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

/** The prefix is only cached for the model and thinking level that produced it. */
function forksForeground(prefix: ForegroundFork, model: Model<Api>, thinking: ModelThinkingLevel): boolean {
	return prefix.reply.provider === model.provider && prefix.reply.model === model.id && (prefix.reply.thinkingLevel ?? "off") === thinking;
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

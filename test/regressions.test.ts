import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fork } from "node:child_process";
import { once } from "node:events";
import { createEditTool, createWriteTool, SessionManager, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { BeforeAgentStartEventResult } from "@earendil-works/pi-coding-agent";
import type { Context } from "@earendil-works/pi-ai";
import factory from "../src/index.ts";
import { LIMITS, loadConfig, resolvePaths } from "../src/config.ts";
import { readDreamState } from "../src/dream.ts";
import { applyExtractOps, collectEntriesSince } from "../src/extract.ts";
import { parseMemory, serializeMemory } from "../src/frontmatter.ts";
import { listMemories, truncateMemory } from "../src/store.ts";
import { MemoryJobs, type MemoryJobRequest } from "../src/workflow.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;
interface Command { handler: (args: string, ctx: ExtensionContext) => unknown | Promise<unknown>; }

async function withSession(run: (session: Awaited<ReturnType<typeof createSession>>) => Promise<void>) {
	const session = await createSession();
	try { await run(session); } finally { await session.close(); }
}

async function createSession() {
	const previousCwd = process.cwd();
	const previousRoot = process.env.PI_MEMORY_DIR;
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-regression-"));
	const cwd = path.join(root, "project");
	fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
	fs.writeFileSync(path.join(cwd, ".pi", "memory.json"), JSON.stringify({ sharedMemory: true, enabled: true, autoExtract: true, autoDream: false, autoExtractMinMessages: 1, recall: true, citeMemories: false }));
	process.env.PI_MEMORY_DIR = path.join(root, "mem");
	process.chdir(cwd);
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, Command>();
	const tools = new Map<string, ToolDefinition>();
	const manager = SessionManager.create(cwd, path.join(root, "sessions"));
	const notifications: string[] = [];
	let modelCalls = 0;
	let modelReply: (request: Context) => Promise<string> | string = () => '{"ops":[]}';
	const parentRule = crypto.randomUUID();
	const config = loadConfig(cwd);
	let activeTools = ["read", "write", "edit", "memory_save"];
	let waitForIdle = async () => {};
	// Only host boundary objects are mocked; history and persistence use the real implementations.
	const ctx = {
		cwd, hasUI: true, sessionManager: manager, model: { id: "test-model" },
		modelRegistry: { complete: async (_model: unknown, request: Context) => {
			modelCalls++;
			return { role: "assistant", stopReason: "stop", content: [{ type: "text", text: await modelReply(request) }], timestamp: Date.now() };
		} },
		getSystemPrompt: () => parentRule,
		ui: { notify: (text: string) => notifications.push(text), setStatus: () => {}, select: async () => undefined },
		waitForIdle: () => waitForIdle(),
	} as unknown as ExtensionContext;
	const api = {
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: Command) => commands.set(name, command),
		registerEntryRenderer: () => {},
		appendEntry: (name: string, data: unknown) => manager.appendCustomEntry(name, data),
		getActiveTools: () => activeTools,
		setActiveTools: (names: string[]) => { activeTools = names; }, sendUserMessage: () => {},
	} as unknown as ExtensionAPI;
	factory(api);
	const emit = async (name: string, event: unknown = {}) => handlers.get(name)?.(event, ctx);
	const command = async (name: string, args = "") => {
		const item = commands.get(name);
		assert.ok(item, `Command is registered: ${name}`);
		return item.handler(args, ctx);
	};
	const save = async (name: string, extra: Record<string, unknown> = {}) => {
		const tool = tools.get("memory_save");
		assert.ok(tool);
		return tool.execute(name, { name, type: "feedback", description: "Durable preference", body: "Preserve prior knowledge", ...extra }, undefined, undefined, ctx);
	};
	const turn = async (prompt: string) => {
		manager.appendMessage({ role: "user", content: prompt, timestamp: Date.now() });
		const result = await emit("before_agent_start", { prompt, systemPrompt: "BASE" }) as BeforeAgentStartEventResult | undefined;
		if (result?.message) manager.appendCustomMessageEntry(result.message.customType, result.message.content, result.message.display, result.message.details);
		return result;
	};
	await emit("session_start");
	return {
		root, cwd, ctx, config, paths: resolvePaths(cwd, config), manager, notifications, emit, command, save, turn,
		modelCalls: () => modelCalls,
		parentRule,
		activeTools: () => activeTools,
		setIdleWaiter: (waiter: () => Promise<void>) => { waitForIdle = waiter; },
		setModelReply: (reply: typeof modelReply) => { modelReply = reply; },
		addUser: (text: string) => manager.appendMessage({ role: "user", content: text, timestamp: Date.now() }),
		close: async () => {
			await emit("session_shutdown");
			process.chdir(previousCwd);
			if (previousRoot === undefined) delete process.env.PI_MEMORY_DIR;
			else process.env.PI_MEMORY_DIR = previousRoot;
			fs.rmSync(root, { recursive: true, force: true });
		},
	};
}

function memory(name: string, body: string, pinned = false) {
	return serializeMemory({ name, description: `description ${name}`, type: "project", pinned, originSessionId: "test", modified: new Date().toISOString() }, body);
}

function runMemoryJob(s: Awaited<ReturnType<typeof createSession>>, kind: MemoryJobRequest["kind"]) {
	return new MemoryJobs().run(s.ctx, {
		kind, paths: s.paths, sessionId: s.manager.getSessionId(),
		systemPrompt: s.parentRule, prompt: crypto.randomUUID(),
	});
}

function modelReadResults(request: Context): readonly unknown[] {
	const message = request.messages.at(-1);
	assert.ok(message?.role === "user" && typeof message.content === "string");
	const reply: unknown = JSON.parse(message.content);
	assert.ok(typeof reply === "object" && reply !== null && "files" in reply && Array.isArray(reply.files));
	return reply.files;
}

async function changeMemoryWithBuiltin(s: Awaited<ReturnType<typeof createSession>>, toolName: "write" | "edit", content: string) {
	const file = path.join(s.paths.personalDir, `${crypto.randomUUID()}.md`);
	const updated = `${content}\n${crypto.randomUUID()}`;
	if (toolName === "write") {
		const input = { path: file, content: updated };
		assert.equal(await s.emit("tool_call", { toolName, input }), undefined);
		await createWriteTool(s.cwd).execute(crypto.randomUUID(), input);
		await s.emit("tool_result", { toolName, input, isError: false });
	} else {
		fs.writeFileSync(file, content);
		const input = { path: file, edits: [{ oldText: content, newText: updated }] };
		assert.equal(await s.emit("tool_call", { toolName, input }), undefined);
		await createEditTool(s.cwd).execute(crypto.randomUUID(), input);
		await s.emit("tool_result", { toolName, input, isError: false });
	}
	return parseMemory(fs.readFileSync(file, "utf8"));
}

test("same-basename projects have isolated personal memory", async () => withSession(async (s) => {
	const a = path.join(s.root, "a", "repo"), b = path.join(s.root, "b", "repo");
	fs.mkdirSync(a, { recursive: true }); fs.mkdirSync(b, { recursive: true });
	assert.notEqual(resolvePaths(a, s.config).personalDir, resolvePaths(b, s.config).personalDir);
}));

test("a direct write consumes only its own extraction window", async () => withSession(async (s) => {
	s.addUser("Please remember this durable preference");
	await s.save("first");
	await s.emit("agent_settled");
	assert.equal(s.modelCalls(), 0);
	s.addUser("Another durable preference arrived later");
	await s.emit("agent_settled");
	assert.equal(s.modelCalls(), 1);
}));

test("compaction losing a cursor still permits future extraction", async () => withSession(async (s) => {
	const cursor = s.addUser("Old durable preference to extract");
	await s.emit("agent_settled");
	const kept = s.addUser("A recent durable preference remains");
	s.manager.appendCompaction("Old history summarized", kept, 100);
	s.addUser("New durable preference after compaction");
	assert.ok(collectEntriesSince(s.manager.buildContextEntries(), cursor).views.length > 0);
	await s.emit("agent_settled");
	assert.equal(s.modelCalls(), 2);
}));

test("pause recognizes relative memory paths without blocking sibling directories", async () => withSession(async (s) => {
	await s.command("pause-memory");
	const inside = await s.emit("tool_call", { toolName: "write", input: { path: ".pi/memory/new.md" } });
	assert.ok(inside && typeof inside === "object" && "block" in inside && inside.block === true);
	assert.equal(await s.emit("tool_call", { toolName: "read", input: { path: `${s.paths.personalDir}-backup/file.md` } }), undefined);
}));

test("promotion preserves both conflicting memories and respects pause", async () => withSession(async (s) => {
	assert.ok(s.paths.teamDir);
	const source = path.join(s.paths.personalDir, "conflict.md"), target = path.join(s.paths.teamDir, "conflict.md");
	const privateText = memory("conflict", "private knowledge"), teamText = memory("conflict", "team knowledge");
	fs.writeFileSync(source, privateText); fs.writeFileSync(target, teamText);
	await s.command("remember", "conflict.md");
	assert.equal(fs.readFileSync(source, "utf8"), privateText);
	assert.equal(fs.readFileSync(target, "utf8"), teamText);
	fs.unlinkSync(target);
	await s.command("pause-memory");
	await s.command("remember", "conflict.md");
	assert.equal(fs.readFileSync(source, "utf8"), privateText);
	assert.equal(fs.existsSync(target), false);
}));

test("concurrent saves enforce the pinned limit within serialization", async () => withSession(async (s) => {
	for (let i = 0; i < LIMITS.maxPinned - 1; i++) await s.save(`pin-${i}`, { pinned: true });
	await Promise.all([s.save("pin-last", { pinned: true }), s.save("pin-extra", { pinned: true })]);
	assert.equal(listMemories(s.paths).filter((item) => item.pinned).length, LIMITS.maxPinned);
}));

test("extraction can update an existing pin at capacity", async () => withSession(async (s) => {
	for (let i = 0; i < LIMITS.maxPinned; i++) await s.save(`pin-${i}`, { pinned: true });
	await applyExtractOps(s.paths, [{ op: "upsert", file: "pin-0.md", type: "feedback", description: "Updated preference", body: "Updated durable content", pinned: true }], "test");
	assert.equal(parseMemory(fs.readFileSync(path.join(s.paths.personalDir, "pin-0.md"), "utf8")).body.trim(), "Updated durable content");
}));

test("index rejection leaves an existing memory unchanged", async () => withSession(async (s) => {
	await s.save("existing");
	const file = path.join(s.paths.personalDir, "existing.md"), before = fs.readFileSync(file, "utf8");
	await s.save("existing", { body: "Should never be committed", indexLine: `- [existing](existing.md) — ${"x".repeat(LIMITS.indexMaxBytes + 1)}` });
	assert.equal(fs.readFileSync(file, "utf8"), before);
}));

test("extraction index rejection creates no orphan memory", async () => withSession(async (s) => {
	fs.writeFileSync(path.join(s.paths.personalDir, "MEMORY.md"), Array.from({ length: LIMITS.indexMaxLines }, (_, i) => `- [entry](entry-${i}.md) — Existing indexed fact`).join("\n"));
	await applyExtractOps(s.paths, [{ op: "upsert", file: "orphan.md", type: "project", description: "New fact", body: "Knowledge that cannot fit the index" }], "test");
	assert.equal(fs.existsSync(path.join(s.paths.personalDir, "orphan.md")), false);
}));

test("legacy import is explicit, preserves the source, and never overwrites a target", async () => withSession(async (s) => {
	const legacy = path.join(s.root, "mem", path.basename(s.cwd));
	fs.mkdirSync(legacy);
	const source = path.join(legacy, "legacy.md"), original = memory("legacy", "old durable knowledge");
	fs.writeFileSync(source, original);
	await s.emit("session_start");
	assert.equal(fs.existsSync(path.join(s.paths.personalDir, "legacy.md")), false);
	await s.command("memory", "import-legacy");
	assert.equal(fs.readFileSync(path.join(s.paths.personalDir, "legacy.md"), "utf8"), original);
	fs.writeFileSync(source, memory("legacy", "changed legacy knowledge"));
	await s.command("memory", "import-legacy");
	assert.equal(fs.readFileSync(path.join(s.paths.personalDir, "legacy.md"), "utf8"), original);
	assert.ok(fs.readFileSync(source, "utf8").includes("changed legacy knowledge"));
}));

test("relative builtin writes are stamped and count only for their own extraction window", async () => withSession(async (s) => {
	const { createWriteTool } = await import("@earendil-works/pi-coding-agent");
	const input = { path: ".pi/memory/builtin.md", content: "---\nname: builtin\ndescription: durable builtin fact\nmetadata:\n  type: project\n---\n\nBody\n" };
	assert.equal(await s.emit("tool_call", { toolName: "write", input }), undefined);
	const writer = createWriteTool(s.cwd);
	await writer.execute("builtin", input);
	await s.emit("tool_result", { toolName: "write", input, isError: false });
	assert.ok(s.paths.teamDir);
	assert.equal(parseMemory(fs.readFileSync(path.join(s.paths.teamDir, "builtin.md"), "utf8")).frontmatter.originSessionId, s.manager.getSessionId());
	s.addUser("Please keep this durable fact");
	await s.emit("agent_settled");
	assert.equal(s.modelCalls(), 0);
	s.addUser("Another durable fact needs separate extraction");
	await s.emit("agent_settled");
	assert.equal(s.modelCalls(), 1);
}));

test("an explicitly requested extraction still respects pause", async () => withSession(async (s) => {
	s.addUser("Please remember a durable preference");
	await s.command("pause-memory");
	await s.command("memory-extract");
	assert.equal(s.modelCalls(), 0);
}));

test("pause path expansion agrees with pi's builtin writer for supported aliases", async () => withSession(async (s) => {
	const { createWriteTool } = await import("@earendil-works/pi-coding-agent");
	const { pathToFileURL } = await import("node:url");
	assert.ok(s.paths.teamDir);
	const destination = path.join(s.paths.teamDir, "alias.md");
	const inputs = ["@.pi/memory/alias.md", pathToFileURL(destination).href];
	if (process.platform === "win32") inputs.push(destination.replace(/^([A-Za-z]):\\/, (_, drive: string) => `/${drive}/`).replaceAll("\\", "/"));
	for (const alias of inputs) {
		await createWriteTool(s.cwd).execute("alias", { path: alias, content: memory("alias", alias) });
		assert.ok(fs.readFileSync(destination, "utf8").includes(alias));
		await s.command("pause-memory");
		const gate = await s.emit("tool_call", { toolName: "write", input: { path: alias } });
		assert.ok(gate && typeof gate === "object" && "block" in gate && gate.block === true);
		await s.command("pause-memory");
	}
}));

test("structured writes cannot follow a memory-directory junction outside its root", async () => withSession(async (s) => {
	assert.ok(s.paths.teamDir);
	const outside = path.join(s.root, "outside");
	fs.mkdirSync(outside);
	fs.symlinkSync(outside, path.join(s.paths.teamDir, "escape"), "junction");
	await assert.rejects(() => applyExtractOps(s.paths, [{ op: "upsert", file: "team/escape/file.md", type: "project", description: "Outside", body: "Must not escape" }], "test"));
	assert.equal(fs.existsSync(path.join(outside, "file.md")), false);
}));

test("recall deduplication follows persisted visible messages across reload and branch changes", async () => withSession(async (s) => {
	const rootEntry = s.addUser("Start here");
	const payload = crypto.randomUUID();
	fs.writeFileSync(path.join(s.paths.personalDir, "deployment.md"), memory("deployment", payload));
	const first = await s.turn("Explain deployment procedures");
	assert.ok(String(first?.message?.content).includes(payload));
	await s.emit("session_start");
	assert.equal((await s.turn("Explain deployment procedures"))?.message, undefined);
	s.manager.branch(rootEntry);
	await s.emit("session_tree");
	assert.ok(String((await s.turn("Explain deployment procedures"))?.message?.content).includes(payload));
}));

test("compaction restores recall eligibility for discarded attachments", async () => withSession(async (s) => {
	const payload = crypto.randomUUID();
	fs.writeFileSync(path.join(s.paths.personalDir, "deployment.md"), memory("deployment", payload));
	await s.turn("Explain deployment procedures");
	const kept = s.addUser("Context retained after compaction");
	s.manager.appendCompaction("Previous work summary", kept, 500);
	await s.emit("session_compact");
	assert.ok(String((await s.turn("Explain deployment procedures"))?.message?.content).includes(payload));
}));

test("changed and deleted recalled files invalidate old context without keyword matches", async () => withSession(async (s) => {
	const file = path.join(s.paths.personalDir, "deployment.md");
	const original = crypto.randomUUID();
	const updated = crypto.randomUUID();
	fs.writeFileSync(file, memory("deployment", original));
	await s.turn("Explain deployment procedures");
	fs.writeFileSync(file, memory("deployment", updated));
	const changed = await s.turn("ok");
	assert.ok(String(changed?.message?.content).includes(updated));
	assert.ok(!String(changed?.message?.content).includes(original));
	assert.equal((await s.turn("ok"))?.message, undefined);
	fs.unlinkSync(file);
	assert.ok((await s.turn("ok"))?.message);
	assert.equal((await s.turn("ok"))?.message, undefined);
}));

test("pinned and index changes refresh context without changing the system prefix", async () => withSession(async (s) => {
	const file = path.join(s.paths.personalDir, "policy.md");
	const original = crypto.randomUUID();
	const updated = crypto.randomUUID();
	const indexContent = crypto.randomUUID();
	fs.writeFileSync(file, memory("policy", original, true));
	await s.emit("session_start");
	const first = await s.turn("hello");
	fs.writeFileSync(file, memory("policy", updated, true));
	fs.writeFileSync(path.join(s.paths.personalDir, "MEMORY.md"), indexContent);
	const changed = await s.turn("ok");
	assert.equal(changed?.systemPrompt, first?.systemPrompt);
	assert.ok(String(changed?.message?.content).includes(updated));
	assert.ok(String(changed?.message?.content).includes(indexContent));
}));

test("pause and extraction cursors follow selected ancestry", async () => withSession(async (s) => {
	const rootEntry = s.addUser("Root");
	await s.command("pause-memory");
	const pausedLeaf = s.manager.getLeafId();
	assert.ok(pausedLeaf);
	s.manager.branch(rootEntry);
	await s.emit("session_tree");
	assert.equal("isError" in await s.save("branch-safe"), false);
	s.manager.branch(pausedLeaf);
	await s.emit("session_tree");
	const blocked = await s.save("blocked-on-old-branch");
	assert.ok("isError" in blocked && blocked.isError === true);
	s.manager.branch(rootEntry);
	await s.emit("session_start");
	s.addUser("Please remember this durable branch preference");
	await s.emit("agent_settled");
	assert.equal(s.modelCalls(), 1);
}));

test("pins outside the system snapshot remain eligible for recall", async () => withSession(async (s) => {
	const payloads = Array.from({ length: LIMITS.maxPinned + 1 }, () => crypto.randomUUID());
	for (const [index, payload] of payloads.entries())
		fs.writeFileSync(path.join(s.paths.personalDir, `policy-${index}.md`), memory(`policy-${index}`, payload, true));
	await s.emit("session_start");
	const result = await s.turn("Explain policy guidelines");
	assert.ok(result?.message);
	const context = `${result.systemPrompt}\n${result.message.content}`;
	assert.ok(payloads.every((payload) => context.includes(payload)));
}));

test("recall budget survives reload while exhausted context still invalidates changed files", async () => withSession(async (s) => {
	const payload = crypto.randomUUID().repeat(100);
	const count = Math.ceil(LIMITS.recallSessionBudgetBytes / payload.length) + LIMITS.recallMaxFiles;
	for (let i = 0; i < count; i++)
		fs.writeFileSync(path.join(s.paths.personalDir, `policy-${i}.md`), memory(`policy-${i}`, payload));
	const recalled: string[] = [];
	for (let i = 0; i < count; i++) {
		const result = await s.turn("Explain policy guidelines");
		if (!result?.message) break;
		recalled.push(String(result.message.content));
	}
	assert.ok(recalled.length > 0);
	assert.ok(recalled.join("").split(payload).length - 1 < count);
	await s.emit("session_start");
	assert.equal((await s.turn("Explain policy guidelines"))?.message, undefined);
	const selected = fs.readdirSync(s.paths.personalDir).find((ref) => recalled.some((text) => text.includes(ref)));
	assert.ok(selected);
	const updated = crypto.randomUUID().repeat(100);
	fs.writeFileSync(path.join(s.paths.personalDir, selected), memory(selected.replace(/\.md$/, ""), updated));
	const invalidated = await s.turn("ok");
	assert.ok(invalidated?.message);
	assert.ok(!String(invalidated.message.content).includes(updated));
	assert.equal((await s.turn("ok"))?.message, undefined);
}));

test("extraction restores its consumed cursor after session reload", async () => withSession(async (s) => {
	s.addUser("Please retain this durable preference");
	await s.emit("agent_settled");
	assert.equal(s.modelCalls(), 1);
	await s.emit("session_start");
	await s.emit("agent_settled");
	assert.equal(s.modelCalls(), 1);
}));

test("extraction reads complete prior content and inherits parent context before updating", async () => withSession(async (s) => {
	const prior = crypto.randomUUID();
	const added = crypto.randomUUID();
	const file = path.join(s.paths.personalDir, "policy.md");
	fs.writeFileSync(file, memory("policy", prior, true));
	let calls = 0;
	s.setModelReply((request) => {
		assert.ok(request.systemPrompt?.includes(s.parentRule));
		if (++calls === 1) return JSON.stringify({ read: ["policy.md"] });
		assert.ok(JSON.stringify(request.messages).includes(prior));
		return JSON.stringify({ ops: [{ op: "upsert", file: "policy.md", type: "project", description: "Policy", body: `${prior}\n${added}` }] });
	});
	await s.command("memory-extract");
	const saved = parseMemory(fs.readFileSync(file, "utf8"));
	assert.ok(saved.body.includes(prior) && saved.body.includes(added));
	assert.equal(saved.frontmatter.pinned, true);
	assert.equal(saved.frontmatter.originSessionId, "test");
}));

test("an extraction cannot replace a file changed after its model read", async () => withSession(async (s) => {
	const file = path.join(s.paths.personalDir, "policy.md");
	fs.writeFileSync(file, memory("policy", crypto.randomUUID()));
	const concurrent = memory("policy", crypto.randomUUID());
	let calls = 0;
	s.setModelReply(() => {
		if (++calls === 1) return JSON.stringify({ read: ["policy.md"] });
		fs.writeFileSync(file, concurrent);
		return JSON.stringify({ ops: [{ op: "upsert", file: "policy.md", type: "project", description: "Policy", body: crypto.randomUUID() }] });
	});
	await s.command("memory-extract");
	assert.equal(fs.readFileSync(file, "utf8"), concurrent);
}));

test("pause discards a late model response before it can write", async () => withSession(async (s) => {
	const response = Promise.withResolvers<string>();
	const started = Promise.withResolvers<void>();
	s.setModelReply(() => { started.resolve(); return response.promise; });
	s.addUser("Remember this durable project preference");
	const extraction = s.emit("agent_settled");
	await started.promise;
	await s.command("pause-memory");
	response.resolve(JSON.stringify({ ops: [{ op: "upsert", file: "late.md", type: "project", description: "Late", body: crypto.randomUUID() }] }));
	await extraction;
	assert.equal(fs.existsSync(path.join(s.paths.personalDir, "late.md")), false);
	assert.ok(!s.manager.getBranch().some((entry) => entry.type === "custom" && entry.customType === "pi-memory:extracted"));
}));

test("changing session during extraction prevents writes and cursor updates", async () => withSession(async (s) => {
	const response = Promise.withResolvers<string>();
	const started = Promise.withResolvers<void>();
	s.setModelReply(() => { started.resolve(); return response.promise; });
	s.addUser("Remember this durable project preference");
	const extraction = s.emit("agent_settled");
	await started.promise;
	await s.emit("session_before_switch");
	s.manager.newSession();
	await s.emit("session_start");
	response.resolve(JSON.stringify({ ops: [{ op: "upsert", file: "old-session.md", type: "project", description: "Late", body: crypto.randomUUID() }] }));
	await extraction;
	assert.equal(fs.existsSync(path.join(s.paths.personalDir, "old-session.md")), false);
	assert.ok(!s.manager.getBranch().some((entry) => entry.type === "custom" && entry.customType === "pi-memory:extracted"));
}));

test("a direct-write skip remains consumed across session reload", async () => withSession(async (s) => {
	s.addUser("Remember this durable project preference");
	await s.save("preference");
	await s.emit("agent_settled");
	await s.emit("session_start");
	await s.emit("agent_settled");
	assert.equal(s.modelCalls(), 0);
	s.addUser("Remember an additional durable project preference");
	await s.emit("agent_settled");
	assert.equal(s.modelCalls(), 1);
}));

test("extraction requests a read instead of replacing unseen existing content", async () => withSession(async (s) => {
	const file = path.join(s.paths.personalDir, "policy.md");
	const original = memory("policy", crypto.randomUUID());
	fs.writeFileSync(file, original);
	s.setModelReply(() => JSON.stringify({ ops: [{ op: "upsert", file: "policy.md", type: "project", description: "Policy", body: crypto.randomUUID() }] }));
	await s.command("memory-extract");
	assert.ok(s.modelCalls() > 1);
	assert.equal(fs.readFileSync(file, "utf8"), original);
}));

test("a structured extraction batch observes its own earlier successful writes", async () => withSession(async (s) => {
	const names = ["first-policy", "second-policy"];
	const payload = crypto.randomUUID();
	s.setModelReply(() => JSON.stringify({ ops: names.map((name) => ({ op: "upsert", file: `${name}.md`, type: "project", description: name, body: payload })) }));
	await s.command("memory-extract");
	for (const name of names) assert.equal(parseMemory(fs.readFileSync(path.join(s.paths.personalDir, `${name}.md`), "utf8")).body.trim(), payload);
}));

test("cancellation prevents queued effects while preserving earlier committed operations", async () => withSession(async (s) => {
	const { withFileMutationQueue } = await import("@earendil-works/pi-coding-agent");
	const released = Promise.withResolvers<void>();
	const locked = Promise.withResolvers<void>();
	const second = path.join(s.paths.personalDir, "second.md");
	const holding = withFileMutationQueue(second, async () => { locked.resolve(); await released.promise; });
	await locked.promise;
	s.setModelReply(() => JSON.stringify({ ops: ["first.md", "second.md"].map((file) => ({ op: "upsert", file, type: "project", description: file, body: crypto.randomUUID() })) }));
	const firstWritten = Promise.withResolvers<void>();
	const notificationTimeoutMs = 5000;
	const timeout = setTimeout(() => firstWritten.reject(new Error("No committed file notification")), notificationTimeoutMs);
	const watcher = fs.watch(s.paths.personalDir, () => {
		if (fs.existsSync(path.join(s.paths.personalDir, "first.md"))) firstWritten.resolve();
	});
	const extraction = s.command("memory-extract");
	try {
		await firstWritten.promise;
		assert.equal(fs.existsSync(path.join(s.paths.personalDir, "first.md")), true);
		await s.command("pause-memory");
	} finally { clearTimeout(timeout); watcher.close(); released.resolve(); }
	await holding;
	await extraction;
	assert.equal(fs.existsSync(second), false);
	assert.equal(fs.existsSync(path.join(s.paths.personalDir, "first.md")), true);
}));

function addHistoricalSession(s: Awaited<ReturnType<typeof createSession>>, text: string) {
	const manager = SessionManager.create(s.cwd, s.manager.getSessionDir());
	manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
	manager.appendMessage({ role: "assistant", content: [{ type: "text", text: crypto.randomUUID() }], api: "openai-completions", provider: "fixture", model: "fixture", stopReason: "stop", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
	return manager;
}

test("project switches survive reload and preserve unrelated settings", async () => withSession(async (s) => {
	const file = path.join(s.cwd, ".pi", "memory.json");
	const unrelated = crypto.randomUUID();
	fs.writeFileSync(file, JSON.stringify({ sharedMemory: true, custom: unrelated }));
	await s.command("memory", "auto-extract off");
	await s.command("memory", "auto-dream on");
	await s.command("memory", "off");
	await s.emit("session_start");
	assert.equal(s.activeTools().includes("memory_save"), false);
	await s.save("disabled");
	assert.equal(fs.existsSync(path.join(s.paths.personalDir, "disabled.md")), false);
	const config = loadConfig(s.cwd);
	assert.equal(config.enabled, false);
	assert.equal(config.autoExtract, false);
	assert.equal(config.autoDream, true);
	assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).custom, unrelated);
	await s.command("memory", "on");
	await s.emit("session_start");
	assert.ok(s.activeTools().includes("memory_save"));
	await s.save("enabled");
	assert.ok(fs.existsSync(path.join(s.paths.personalDir, "enabled.md")));
}));

test("invalid settings remain intact and failed saves do not change running switches", async () => withSession(async (s) => {
	const file = path.join(s.cwd, ".pi", "memory.json");
	const broken = crypto.randomUUID();
	fs.writeFileSync(file, broken);
	await s.command("memory", "off");
	assert.equal(fs.readFileSync(file, "utf8"), broken);
	await s.save("still-enabled");
	assert.ok(fs.existsSync(path.join(s.paths.personalDir, "still-enabled.md")));
}));

test("manual Dream delivers live and saved Pi contexts and records a successful no-op", async () => withSession(async (s) => {
	const live = crypto.randomUUID(), historical = crypto.randomUUID();
	s.addUser(live);
	addHistoricalSession(s, historical);
	await s.save("unchanged");
	const file = path.join(s.paths.personalDir, "unchanged.md");
	const content = fs.readFileSync(file, "utf8");
	fs.utimesSync(file, new Date(0), new Date(0));
	s.setModelReply((request) => {
		assert.ok(request.systemPrompt?.includes(s.parentRule));
		assert.ok(JSON.stringify(request.messages).includes(live));
		assert.ok(JSON.stringify(request.messages).includes(historical));
		return JSON.stringify({ ops: [] });
	});
	const before = Date.now();
	await s.command("dream");
	const state = readDreamState(s.paths);
	assert.ok(state.lastCompletedAt !== null && state.lastCompletedAt >= before);
	assert.ok(state.through >= before && state.through <= state.lastCompletedAt);
	assert.equal(fs.readFileSync(file, "utf8"), content);
	assert.equal(fs.statSync(file).mtimeMs, 0);
}));

test("Dream reads project evidence through Pi and preserves memory facts while consolidating", async () => withSession(async (s) => {
	const evidence = crypto.randomUUID(), retained = crypto.randomUUID();
	fs.writeFileSync(path.join(s.cwd, "policy.txt"), evidence);
	await s.save("policy", { body: retained });
	let calls = 0;
	s.setModelReply((request) => {
		if (++calls === 1) return JSON.stringify({ readProject: ["policy.txt"] });
		assert.ok(JSON.stringify(request.messages).includes(evidence));
		if (calls === 2) return JSON.stringify({ read: ["policy.md"] });
		assert.ok(JSON.stringify(request.messages).includes(retained));
		return JSON.stringify({ ops: [{ op: "upsert", file: "policy.md", type: "project", description: "policy", body: `${retained}\n${evidence}` }] });
	});
	await s.command("dream");
	const result = parseMemory(fs.readFileSync(path.join(s.paths.personalDir, "policy.md"), "utf8"));
	assert.ok(result.body.includes(evidence) && result.body.includes(retained));
	assert.ok(readDreamState(s.paths).lastCompletedAt !== null);
}));

test("Dream rejects project reads through an escaping directory link", async () => withSession(async (s) => {
	const outside = path.join(s.root, "outside");
	fs.mkdirSync(outside);
	fs.writeFileSync(path.join(outside, "private.txt"), crypto.randomUUID());
	fs.symlinkSync(outside, path.join(s.cwd, "linked"), "junction");
	s.setModelReply(() => JSON.stringify({ readProject: ["linked/private.txt"] }));
	await s.command("dream");
	assert.equal(s.modelCalls(), 1);
	assert.equal(readDreamState(s.paths).lastCompletedAt, null);
}));

test("automatic Dream waits for new sessions and throttles both failures and successes", async () => withSession(async (s) => {
	await s.command("memory", "auto-extract off");
	await s.command("memory", "auto-dream on");
	s.addUser(crypto.randomUUID());
	await s.emit("agent_settled");
	assert.equal(s.modelCalls(), 0);
	for (let i = 0; i < 6; i++) addHistoricalSession(s, crypto.randomUUID());
	s.setModelReply(() => { throw new Error(crypto.randomUUID()); });
	await s.emit("agent_settled");
	const failedCalls = s.modelCalls();
	assert.ok(failedCalls > 0);
	assert.equal(readDreamState(s.paths).lastCompletedAt, null);
	await s.emit("agent_settled");
	assert.equal(s.modelCalls(), failedCalls);
	s.setModelReply(() => JSON.stringify({ ops: [] }));
	await s.command("dream");
	assert.ok(readDreamState(s.paths).lastCompletedAt !== null);
	const completedCalls = s.modelCalls();
	for (let i = 0; i < 6; i++) addHistoricalSession(s, crypto.randomUUID());
	await s.emit("agent_settled");
	assert.equal(s.modelCalls(), completedCalls);
}));

test("automatic Dream can consolidate with extraction disabled and stays disabled until opted in", async () => withSession(async (s) => {
	await s.command("memory", "auto-extract off");
	for (let i = 0; i < 6; i++) addHistoricalSession(s, crypto.randomUUID());
	s.setModelReply(() => JSON.stringify({ ops: [] }));
	await s.emit("agent_settled");
	assert.equal(s.modelCalls(), 0);
	await s.command("memory", "auto-dream on");
	await s.emit("agent_settled");
	assert.ok(s.modelCalls() > 0);
	assert.ok(readDreamState(s.paths).lastCompletedAt !== null);
}));

test("pausing Dream discards late output and leaves completion unadvanced", async () => withSession(async (s) => {
	const response = Promise.withResolvers<string>(), started = Promise.withResolvers<void>();
	s.setModelReply(() => { started.resolve(); return response.promise; });
	const running = s.command("dream");
	await started.promise;
	await s.command("pause-memory");
	response.resolve(JSON.stringify({ ops: [{ op: "upsert", file: "late.md", type: "project", description: "late", body: crypto.randomUUID() }] }));
	await running;
	assert.equal(fs.existsSync(path.join(s.paths.personalDir, "late.md")), false);
	assert.equal(readDreamState(s.paths).lastCompletedAt, null);
	await s.command("pause-memory");
	s.setModelReply(() => JSON.stringify({ ops: [] }));
	await s.command("dream");
	assert.ok(readDreamState(s.paths).lastCompletedAt !== null);
}));

test("partial Dream keeps committed memories without marking consolidation complete", async () => withSession(async (s) => {
	const saved = crypto.randomUUID();
	s.setModelReply(() => JSON.stringify({ ops: [
		{ op: "upsert", file: "durable.md", type: "project", description: "durable", body: saved },
		{ op: "upsert", file: "invalid.md", type: "unsupported", description: "invalid", body: crypto.randomUUID() },
	] }));
	await s.command("dream");
	assert.ok(parseMemory(fs.readFileSync(path.join(s.paths.personalDir, "durable.md"), "utf8")).body.includes(saved));
	assert.equal(fs.existsSync(path.join(s.paths.personalDir, "invalid.md")), false);
	assert.equal(readDreamState(s.paths).lastCompletedAt, null);
}));

test("Dream cannot promote private knowledge into a new team file", async () => withSession(async (s) => {
	s.setModelReply(() => JSON.stringify({ ops: [{ op: "upsert", file: "team/private.md", type: "project", description: "private", body: crypto.randomUUID() }] }));
	await s.command("dream");
	assert.equal(fs.existsSync(path.join(s.paths.teamDir!, "private.md")), false);
	assert.equal(readDreamState(s.paths).lastCompletedAt, null);
}));

test("another process holding Dream state prevents model execution and releases ownership", async () => withSession(async (s) => {
	s.setModelReply(() => JSON.stringify({ ops: [] }));
	await s.command("dream");
	const state = readDreamState(s.paths);
	const count = s.modelCalls();
	const child = fork(new URL("./fixtures/hold-state-lock.ts", import.meta.url), [path.join(s.paths.personalDir, ".dream-state.json")], { cwd: new URL("..", import.meta.url), execArgv: ["--import", "jiti/register"], stdio: ["ignore", "ignore", "inherit", "ipc"] });
	const exited = once(child, "exit");
	try {
		await Promise.race([once(child, "message"), exited.then(() => { throw new Error("Lock worker exited before acquiring ownership"); })]);
		await s.command("dream");
		assert.equal(s.modelCalls(), count);
		assert.deepEqual(readDreamState(s.paths), state);
		child.send({ release: true });
		await exited;
		await s.command("dream");
		assert.ok(s.modelCalls() > count);
	} finally {
		if (child.exitCode === null) child.kill();
		await exited;
	}
}));

test("pausing during Pi session enumeration cancels Dream before model execution", async (t) => withSession(async (s) => {
	const started = Promise.withResolvers<void>();
	const listed = Promise.withResolvers<Awaited<ReturnType<typeof SessionManager.list>>>();
	t.mock.method(SessionManager, "list", () => { started.resolve(); return listed.promise; });
	const running = s.command("dream");
	await started.promise;
	await s.command("pause-memory");
	await running;
	listed.resolve([]);
	assert.equal(s.modelCalls(), 0);
	assert.equal(readDreamState(s.paths).lastAttemptAt, null);
}));

test("automatic Dream requires elapsed completion time and resumes after the interval", async () => withSession(async (s) => {
	await s.command("memory", "auto-extract off");
	await s.command("memory", "auto-dream on");
	s.setModelReply(() => JSON.stringify({ ops: [] }));
	await s.command("dream");
	const state = readDreamState(s.paths);
	const file = path.join(s.paths.personalDir, ".dream-state.json");
	const yesterday = Date.now() - 48 * 60 * 60_000;
	// Arrange an expired retry window with a recent successful completion.
	fs.writeFileSync(file, JSON.stringify({ ...state, lastAttemptAt: yesterday, through: yesterday }));
	for (let i = 0; i < 6; i++) addHistoricalSession(s, crypto.randomUUID());
	const count = s.modelCalls();
	await s.emit("agent_settled");
	assert.equal(s.modelCalls(), count);
	fs.writeFileSync(file, JSON.stringify({ ...state, lastAttemptAt: yesterday, lastCompletedAt: yesterday, through: yesterday }));
	await s.emit("agent_settled");
	assert.ok(s.modelCalls() > count);
	assert.ok(readDreamState(s.paths).through > yesterday);
}));

test("Dream waiting for foreground idle cannot start in a replacement session", async () => withSession(async (s) => {
	const idle = Promise.withResolvers<void>();
	s.setIdleWaiter(() => idle.promise);
	const running = s.command("dream");
	await s.emit("session_start");
	idle.resolve();
	await running;
	assert.equal(s.modelCalls(), 0);
	assert.equal(readDreamState(s.paths).lastAttemptAt, null);
}));

for (const target of ["missing", "directory", "image"] as const) {
	test(`Dream returns project read errors for ${target} targets and completes later operations`, async () => withSession(async (s) => {
		const file = target === "image" ? "evidence.png" : target;
		if (target === "directory") fs.mkdirSync(path.join(s.cwd, file));
		if (target === "image") {
			// A real PNG makes Pi's read tool return an image attachment.
			fs.writeFileSync(path.join(s.cwd, file), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
		}
		const payload = crypto.randomUUID();
		fs.writeFileSync(path.join(s.cwd, "available.txt"), payload);
		let received: readonly unknown[] | undefined;
		s.setModelReply((request) => {
			if (s.modelCalls() === 1) return JSON.stringify({ readProject: [file, "available.txt"] });
			received = modelReadResults(request);
			return JSON.stringify({ ops: [{ op: "upsert", file: "recovered.md", type: "project", description: payload, body: payload }] });
		});
		const result = await runMemoryJob(s, "dream");
		assert.ok(received);
		const failed = received.find((entry) => typeof entry === "object" && entry !== null && "path" in entry && entry.path === file);
		assert.ok(typeof failed === "object" && failed !== null && "error" in failed && typeof failed.error === "string");
		const available = received.find((entry) => typeof entry === "object" && entry !== null && "path" in entry && entry.path === "available.txt");
		assert.ok(typeof available === "object" && available !== null && "content" in available && available.content === payload);
		assert.equal(result.status, "completed");
		assert.equal(result.applied, 1);
		assert.equal(parseMemory(fs.readFileSync(path.join(s.paths.personalDir, "recovered.md"), "utf8")).body.trim(), payload);
	}));
}

for (const boundary of ["absolute", "parent", "missing-parent", "linked", "missing-linked"] as const) {
	test(`Dream enforces project read boundaries for ${boundary} paths`, async () => withSession(async (s) => {
		const outside = path.join(s.root, "outside");
		fs.mkdirSync(outside);
		fs.writeFileSync(path.join(outside, "private.txt"), crypto.randomUUID());
		fs.writeFileSync(path.join(s.cwd, "inside.txt"), crypto.randomUUID());
		if (boundary.includes("linked")) fs.symlinkSync(outside, path.join(s.cwd, "linked"), "junction");
		const files = {
			absolute: path.join(s.cwd, "inside.txt"),
			parent: "../outside/private.txt",
			"missing-parent": "../outside/missing.txt",
			linked: "linked/private.txt",
			"missing-linked": "linked/missing.txt",
		};
		s.setModelReply(() => s.modelCalls() === 1
			? JSON.stringify({ readProject: [files[boundary]] })
			: JSON.stringify({ ops: [{ op: "upsert", file: "forbidden.md", type: "project", description: "boundary", body: crypto.randomUUID() }] }));
		const result = await runMemoryJob(s, "dream");
		assert.equal(result.status, "failed");
		assert.equal(s.modelCalls(), 1);
		assert.equal(result.applied, 0);
		assert.equal(fs.existsSync(path.join(s.paths.personalDir, "forbidden.md")), false);
	}));
}

for (const kind of ["dream", "extract"] as const) {
	for (const writeInvalid of [false, true]) {
		test(`${kind} reports invalid memory references and ${writeInvalid ? "rejects their writes" : "continues with valid operations"}`, async () => withSession(async (s) => {
			await s.save("retained", { body: crypto.randomUUID() });
			const indexFile = path.join(s.paths.personalDir, "MEMORY.md");
			const original = fs.readFileSync(indexFile, "utf8");
			const payload = crypto.randomUUID();
			let received: readonly unknown[] | undefined;
			s.setModelReply((request) => {
				if (s.modelCalls() === 1) return JSON.stringify({ read: ["MEMORY.md"] });
				received = modelReadResults(request);
				return JSON.stringify({ ops: [{ op: "upsert", file: writeInvalid ? "MEMORY.md" : "recovered.md", type: "project", description: payload, body: payload }] });
			});
			const result = await runMemoryJob(s, kind);
			assert.ok(received);
			const failed = received.find((entry) => typeof entry === "object" && entry !== null && "ref" in entry && entry.ref === "MEMORY.md");
			assert.ok(typeof failed === "object" && failed !== null && "error" in failed && typeof failed.error === "string");
			if (writeInvalid) {
				assert.equal(result.status, "failed");
				assert.equal(result.applied, 0);
				assert.equal(fs.readFileSync(indexFile, "utf8"), original);
			} else {
				assert.equal(result.status, "completed");
				assert.equal(result.applied, 1);
				assert.equal(parseMemory(fs.readFileSync(path.join(s.paths.personalDir, "recovered.md"), "utf8")).body.trim(), payload);
			}
		}));
	}
}

for (const toolName of ["write", "edit"] as const) {
	test(`${toolName} provenance refresh preserves replacement metacharacters in frontmatter values`, async () => withSession(async (s) => {
		const name = crypto.randomUUID();
		const description = ["$$", "$&", "$`", "$'"].map((token) => `${crypto.randomUUID()}${token}`).join(" ");
		const origin = crypto.randomUUID(), body = crypto.randomUUID();
		const oldModified = new Date(0).toISOString();
		const content = `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\nmetadata:\n  originSessionId: ${JSON.stringify(origin)}\n  modified: ${JSON.stringify(oldModified)}\n  type: feedback\n  pinned: true\n---\n\n${body}`;
		const started = Date.now();
		const result = await changeMemoryWithBuiltin(s, toolName, content);
		assert.equal(result.frontmatter.name, name);
		assert.equal(result.frontmatter.description, description);
		assert.equal(result.frontmatter.originSessionId, origin);
		assert.equal(result.frontmatter.type, "feedback");
		assert.equal(result.frontmatter.pinned, true);
		assert.ok(result.frontmatter.modified !== null && Date.parse(result.frontmatter.modified) >= started);
		assert.ok(result.body.includes(body));
	}));

	test(`${toolName} inserts missing provenance timestamps without losing nested memory metadata`, async () => withSession(async (s) => {
		const origin = crypto.randomUUID(), body = crypto.randomUUID();
		const content = `---\nname: ${crypto.randomUUID()}\ndescription: ${crypto.randomUUID()}\nmetadata:\n  originSessionId: ${JSON.stringify(origin)}\n  type: project\n  pinned: true\n---\n\n${body}`;
		const started = Date.now();
		const result = await changeMemoryWithBuiltin(s, toolName, content);
		assert.equal(result.frontmatter.originSessionId, origin);
		assert.equal(result.frontmatter.type, "project");
		assert.equal(result.frontmatter.pinned, true);
		assert.ok(result.frontmatter.modified !== null && Date.parse(result.frontmatter.modified) >= started);
		assert.ok(result.body.includes(body));
	}));
}

for (const [encoding, unit] of [["ASCII", crypto.randomUUID()], ["multibyte", "记忆"], ["surrogate pairs", "🧠"]]) {
	test(`single-line ${encoding} memory retains the longest prefix within the byte limit`, async () => withSession(async (s) => {
		const maxBytes = 4096;
		for (const padding of [0, 1, 2, 3]) {
			const raw = "x".repeat(padding) + unit.repeat(maxBytes);
			const rendered = truncateMemory(raw, path.join(s.paths.personalDir, "long.md"), maxBytes);
			// Compare the input prefix without depending on the appended truncation notice.
			let retainedLength = 0;
			while (retainedLength < raw.length && raw[retainedLength] === rendered[retainedLength]) retainedLength++;
			assert.ok(retainedLength > 0 && retainedLength < raw.length);
			assert.ok(Buffer.byteLength(raw.slice(0, retainedLength), "utf8") <= maxBytes);
			assert.ok(Buffer.byteLength(raw.slice(0, retainedLength + 1), "utf8") > maxBytes);
		}
	}));
}

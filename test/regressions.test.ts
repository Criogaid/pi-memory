import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import factory from "../src/index.ts";
import { LIMITS, resolvePaths } from "../src/config.ts";
import { applyExtractOps, collectEntriesSince } from "../src/extract.ts";
import { parseMemory, serializeMemory } from "../src/frontmatter.ts";
import { listMemories } from "../src/store.ts";

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
	fs.writeFileSync(path.join(cwd, ".pi", "memory.json"), JSON.stringify({ sharedMemory: true }));
	process.env.PI_MEMORY_DIR = path.join(root, "mem");
	process.chdir(cwd);
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, Command>();
	const tools = new Map<string, ToolDefinition>();
	const manager = SessionManager.inMemory(cwd);
	const notifications: string[] = [];
	let modelCalls = 0;
	const config = { memoryDir: path.join(root, "mem"), sharedMemory: true, autoExtract: true, autoExtractMinMessages: 1, recall: true, citeMemories: false };
	// Only host boundary objects are mocked; history and persistence use the real implementations.
	const ctx = {
		cwd, hasUI: true, sessionManager: manager, model: { id: "test-model" },
		modelRegistry: { complete: async () => { modelCalls++; return { content: [{ type: "text", text: '{"ops":[]}' }] }; } },
		ui: { notify: (text: string) => notifications.push(text), setStatus: () => {}, select: async () => undefined },
		waitForIdle: async () => {},
	} as unknown as ExtensionContext;
	const api = {
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: Command) => commands.set(name, command),
		registerEntryRenderer: () => {},
		appendEntry: (name: string, data: unknown) => manager.appendCustomEntry(name, data),
		getActiveTools: () => ["read", "write", "edit", "memory_save"],
		setActiveTools: () => {}, sendUserMessage: () => {},
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
	await emit("session_start");
	return {
		root, cwd, config, paths: resolvePaths(cwd, config), manager, notifications, emit, command, save,
		modelCalls: () => modelCalls,
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

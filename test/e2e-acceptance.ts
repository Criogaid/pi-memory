/**
 * End-to-end acceptance test: drives the extension through a simulated pi
 * session lifecycle with a mock ExtensionAPI — the same events pi would fire,
 * in order — and asserts on observable behavior (files, prompts, blocking).
 *
 * Run: npm test
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmp = fs.mkdtempSync(os.tmpdir() + "/pi-e2e-");
const memRoot = path.join(tmp, "mem");
// Project-local config enables team memory; env injects the memory root so
// the test never touches the real ~/.pi.
fs.mkdirSync(path.join(tmp, ".pi"), { recursive: true });
fs.writeFileSync(path.join(tmp, ".pi", "memory.json"), JSON.stringify({ sharedMemory: true }));
process.env.PI_MEMORY_DIR = memRoot;
process.chdir(tmp);
const { default: factory } = await import("../src/index.ts");
const { parseMemory, slugName } = await import("../src/frontmatter.ts");
const { LIMITS, loadConfig, resolvePaths } = await import("../src/config.ts");
const { readDreamState } = await import("../src/dream.ts");

const handlers = new Map<string, Function>();
const tools = new Map<string, any>();
const commands = new Map<string, any>();
const entryRenderers = new Map<string, Function>();
const entries: any[] = [];
const pi: any = {
	on: (ev: string, fn: Function) => handlers.set(ev, async (...args: unknown[]) => {
		const result = await fn(...args);
		// The host persists before_agent_start attachments before the next turn.
		if (ev === "before_agent_start" && result?.message)
			branch.push({ type: "custom_message", ...result.message, id: `recall-${branch.length}` });
		return result;
	}),
	registerTool: (t: any) => tools.set(t.name, t),
	registerCommand: (n: string, o: any) => commands.set(n, o),
	registerEntryRenderer: (t: string, fn: Function) => entryRenderers.set(t, fn),
	appendEntry: (t: string, d: unknown) => entries.push({ type: "custom", customType: t, data: d }),
	sendUserMessage: (m: string) => (pi._sent = m),
	getActiveTools: () => pi._activeTools ?? ["read", "write", "edit", "memory_save"],
	setActiveTools: (names: string[]) => {
		pi._activeTools = names;
	},
	_activeTools: null as string[] | null,
	_sent: null as string | null,
};

factory(pi);

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
	console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? "  (" + detail + ")" : ""}`);
	if (!ok) failures++;
}

console.log("handlers:", [...handlers.keys()].join(","));
console.log("tools:", [...tools.keys()].join(","));
console.log("commands:", [...commands.keys()].join(","));
console.log("entry renderers:", [...entryRenderers.keys()].join(","));

const branch: any[] = [];
function mkCtx(opts: { complete?: Function } = {}) {
	return {
		cwd: process.cwd(),
		hasUI: true,
		ui: {
			notify: (m: string) => console.log("  [notify]", String(m).split("\n")[0]),
			setStatus: () => {},
			select: async (_t: string, items: string[]) => items[0],
		},
		sessionManager: {
			buildContextEntries: () => branch,
			getBranch: () => [...entries, ...branch],
			getEntries: () => entries,
			getSessionId: () => "sess-e2e",
			getSessionDir: () => path.join(tmp, "sessions"),
		},
		model: { id: "mock-model" },
		getSystemPrompt: () => "",
		modelRegistry: { complete: opts.complete ?? (async () => { throw new Error("no model call expected"); }) },
		signal: undefined,
		waitForIdle: async () => {},
	};
}

// 1) session_start creates both memory directories and snapshots the prompt
await handlers.get("session_start")!({}, mkCtx());
const slugDir = fs.readdirSync(memRoot)[0];
check("[1] memory dirs created", Boolean(slugDir), path.join(memRoot, slugDir ?? "?"));

// 2) system prompt carries the real path + Memory section + empty index state
const r2: any = await handlers.get("before_agent_start")!({ systemPrompt: "BASE", prompt: "hello there friend" }, mkCtx());
const sp = r2.systemPrompt as string;
check("[2] real personal path in prompt", sp.includes(path.join(memRoot, slugDir).replace(/\\/g, "/")) || sp.includes(memRoot));
check("[2] no recall before any memory exists", r2.message === undefined);

// 3) memory_save writes file + index + frontmatter + provenance
const save = tools.get("memory_save")!;
const r3 = await save.execute("t1", { name: "Test Runner", type: "project", description: "run npm test", body: "Use `npm test`." }, undefined, undefined, mkCtx());
const savedFiles = fs.readdirSync(path.join(memRoot, slugDir)).filter((f) => f.endsWith(".md") && f !== "MEMORY.md");
const rawSaved = fs.readFileSync(path.join(memRoot, slugDir, savedFiles[0]), "utf-8");
check("[3] save returns success", r3.isError !== true);
check("[3] saved metadata round-trips", parseMemory(rawSaved).frontmatter.type === "project");
check("[3] provenance records the originating session", parseMemory(rawSaved).frontmatter.originSessionId === mkCtx().sessionManager.getSessionId());
check("[3] index updated", fs.readFileSync(path.join(memRoot, slugDir, "MEMORY.md"), "utf-8").includes("test-runner.md"));

// 3b) prompt snapshot stays STABLE after a mid-session save (cache fidelity:
//     Claude Code builds the memory prompt once per session; index edits
//     reach the model via recall messages, not prompt rebuilds)
const r3b: any = await handlers.get("before_agent_start")!({ systemPrompt: "BASE", prompt: "unrelated quantum banana" }, mkCtx());
check("[3b] snapshot unchanged after mid-session save", r3b.systemPrompt === sp, "prefix identical byte-for-byte");

// 4) rejections: secrets + traversal + oversize
const r4a = await save.execute("t2", { name: "leak", type: "user", description: "x", body: "key sk-ant-abcdefghijklmnopqrst" }, undefined, undefined, mkCtx());
check("[4] secret content blocked", r4a.isError === true);
const r4b = await save.execute("t3", { name: "../evil", type: "user", description: "x", body: "y" }, undefined, undefined, mkCtx());
check("[4] traversal name blocked", r4b.isError === true);
const r4c = await save.execute("t4", { name: "big", type: "user", description: "x", body: "x".repeat(5000) }, undefined, undefined, mkCtx());
check("[4] oversize body blocked", r4c.isError === true);

// 5) recall on a matching second prompt, cc-memory gated off
const r5: any = await handlers.get("before_agent_start")!({ systemPrompt: "BASE", prompt: "how do I run the tests here" }, mkCtx());
check("[5] recall message injected", r5?.message?.customType === "pi-memory:recall");
const r5b: any = await handlers.get("before_agent_start")!({ systemPrompt: "BASE", prompt: "how do I run the tests here" }, mkCtx());
check("[5] recall deduped on repeat", r5b?.message === undefined);

// 6) pause blocks writes into memory dirs only
const pauseCmd = commands.get("pause-memory")!;
await pauseCmd.handler("", mkCtx());
const memFileAbs = path.join(memRoot, slugDir, savedFiles[0]);
const r6: any = await handlers.get("tool_call")!({ toolName: "write", input: { path: memFileAbs, content: "x" } }, mkCtx());
check("[6] write to memory blocked when paused", r6?.block === true, r6?.reason ?? "");
const r6b: any = await handlers.get("tool_call")!({ toolName: "write", input: { path: path.join(tmp, "normal.md"), content: "x" } }, mkCtx());
check("[6] normal write unaffected", r6b === undefined);
const r6c: any = await handlers.get("tool_call")!({ toolName: "memory_save", input: { name: "x", type: "user", description: "d", body: "b" } }, mkCtx());
check("[6] memory_save blocked when paused", r6c?.block === true);
await pauseCmd.handler("", mkCtx()); // resume

// 6p) pause gates both reads and writes.
await pauseCmd.handler("", mkCtx()); // pause again
const r6p: any = await handlers.get("tool_call")!({ toolName: "read", input: { path: memFileAbs } }, mkCtx());
check("[6p] read blocked while paused", r6p?.block === true);
const r6q: any = await handlers.get("tool_call")!({ toolName: "write", input: { path: memFileAbs, content: "x" } }, mkCtx());
check("[6p] write blocked while paused", r6q?.block === true);
await pauseCmd.handler("", mkCtx()); // resume

// 6d) `#` memory shortcut transforms input (Claude Code u$t port)
const r6d: any = await handlers.get("input")!({ text: "# always deploy via the ops dashboard", source: "interactive", images: [] }, mkCtx());
check("[6d] # shortcut transforms and preserves the request", r6d?.action === "transform" && r6d.text.includes("always deploy via the ops dashboard"));
const r6e: any = await handlers.get("input")!({ text: "#!/usr/bin/env shebang is not a shortcut", source: "interactive", images: [] }, mkCtx());
check("[6d] #! not treated as shortcut", r6e?.action === "continue");
const r6f: any = await handlers.get("input")!({ text: "# a heading\n\nwith body text after it", source: "interactive", images: [] }, mkCtx());
check("[6d] # with following prose not a shortcut", r6f?.action === "continue");

// 7) Extraction uses visible messages and skips windows covered by direct writes.
for (const [role, text] of [
	["user", "please remember we prefer tabs over spaces in this repo"],
	["assistant", "noted"],
	["user", "also the build must use the locked dependencies"],
	["assistant", "ok"],
	["user", "and never commit directly to main branch"],
	["assistant", "understood"],
	["user", "one more thing about deployment dashboards"],
] as const) {
	branch.push({ type: "message", id: `e${branch.length}`, message: { role, content: [{ type: "text", text }], timestamp: Date.now() } });
}
let settledCalled = false;
await handlers.get("agent_settled")!({}, mkCtx({ complete: async () => { settledCalled = true; return { content: [] }; } }));
check("[7] settled extraction skipped after direct writes", !settledCalled);
const extractCtx = mkCtx({
	complete: async () => ({
		content: [{ type: "text", text: `{"ops":[{"op":"upsert","file":"style-tabs.md","type":"feedback","description":"prefer tabs","body":"Use tabs. **Why:** user corrected me."}]}` }],
	}),
});
await commands.get("memory-extract")!.handler("", extractCtx);
const files = fs.readdirSync(path.join(memRoot, slugDir));
check("[7] extraction wrote file", files.includes("style-tabs.md"), files.join(","));
check("[7] index gained pointer", fs.readFileSync(path.join(memRoot, slugDir, "MEMORY.md"), "utf-8").includes("style-tabs.md"));
const extractEntry = entries.find((e) => e.customType === "pi-memory:extracted");
check("[7] cursor (lastExtractedId) persisted", typeof extractEntry?.data?.lastExtractedId === "string", String(extractEntry?.data?.lastExtractedId));

// 7b) settled again with no new messages -> no model call
let modelCalled = false;
await handlers.get("agent_settled")!({}, mkCtx({ complete: async () => { modelCalled = true; return { content: [] }; } }));
check("[7b] no re-extraction without new messages", !modelCalled);
check("[7c] no evil.md leaked from traversal attempt", !files.includes("evil.md"));

// 7d) entry renderer produces a TUI line for extraction feedback
const rendered = (entryRenderers.get("pi-memory:extracted") as any)({ data: { written: ["style-tabs.md"] } }, {}, { fg: (_c: string, t: string) => t });
check("[7d] extraction entry renders", typeof rendered?.text === "string" && rendered.text.includes("style-tabs.md"));

// 8) /remember promotes a personal memory to team memory
await commands.get("remember")!.handler("test-runner.md", mkCtx());
check("[8] promoted to team dir", fs.existsSync(path.join(process.cwd(), ".pi", "memory", "test-runner.md")));
check("[8] personal copy removed", !fs.existsSync(path.join(memRoot, slugDir, "test-runner.md")));
check("[8] index points at team/", fs.readFileSync(path.join(memRoot, slugDir, "MEMORY.md"), "utf-8").includes("(team/test-runner.md)"));

// 8b) Dream records completion without changing memories on a no-op run.
await commands.get("dream")!.handler("", mkCtx({ complete: async () => ({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ ops: [] }) }], timestamp: Date.now() }) }));
check("[8b] dream persists successful completion", readDreamState(resolvePaths(tmp, loadConfig(tmp))).lastCompletedAt !== null);

// 9) reload restores the extraction cursor from persisted entries
await handlers.get("session_start")!({}, mkCtx());
check("[9] persisted entries present for restore", entries.filter((e) => e.customType === "pi-memory:extracted").length >= 1);

// Round-3 adversarial checks -------------------------------------------------

// 10) CJK queries recall (a Chinese prompt used to tokenize to nothing)
fs.mkdirSync(path.join(memRoot, slugDir), { recursive: true });
fs.writeFileSync(
	path.join(memRoot, slugDir, "deploy-policy.md"),
	"---\nname: deploy-policy\ndescription: 部署必须走运维面板\nmetadata:\n  type: reference\n---\n\n部署经由 ops dashboard。",
);
const r10: any = await handlers.get("before_agent_start")!({ systemPrompt: "BASE", prompt: "部署流程是什么样的" }, mkCtx());
check("[10] CJK query recall", String(r10?.message?.content ?? "").includes("deploy-policy.md"));

// 11) paused `#` shortcut is handled (not passed through to the model)
await pauseCmd.handler("", mkCtx());
const r11: any = await handlers.get("input")!({ text: "# paused shortcut attempt", source: "interactive", images: [] }, mkCtx());
check("[11] paused # shortcut handled with notice", r11?.action === "handled");
// 11b) paused read of a memory file is blocked (Claude Code denies reads too)
const r11b: any = await handlers.get("tool_call")!({ toolName: "read", input: { path: path.join(memRoot, slugDir, "style-tabs.md") } }, mkCtx());
check("[11b] read of memory blocked when paused", r11b?.block === true);
await pauseCmd.handler("", mkCtx()); // resume

// 12) /remember argument completion lists personal memories (pi API reuse)
const completions = commands.get("remember")!.getArgumentCompletions?.("") ?? null;
check("[12] /remember completions list personal memories", Array.isArray(completions) && completions.some((i: any) => i.value === "style-tabs.md"), JSON.stringify(completions?.map((i: any) => i.value)));

// 14) round-11/12 hardening: reserved names, normalization, index-line flattening
const r14a = await save.execute("t5", { name: "con", type: "user", description: "x", body: "y" }, undefined, undefined, mkCtx());
check("[14] Windows reserved name blocked", r14a.isError === true);
await save.execute("t6", { name: "crlf-test", type: "user", description: "d", body: "line one\r\nline two\x0bdone", indexLine: "- [T](crlf-test.md) — a\n- INJECTED LINE" }, undefined, undefined, mkCtx());
const stored14 = fs.readFileSync(path.join(memRoot, slugDir, "crlf-test.md"), "utf-8");
check("[14] CRLF/vertical-tab normalized", stored14.includes("line one\nline two\uFFFDdone") && !stored14.includes("\r"));
const idx14 = fs.readFileSync(path.join(memRoot, slugDir, "MEMORY.md"), "utf-8");
check(
	"[14] custom indexLine flattened to one line",
	idx14.includes("- [T](crlf-test.md) — a - INJECTED LINE") &&
		!idx14.split("\n").some((line: string) => line.trim() === "- INJECTED LINE"),
);

// 15) enabled toggle makes the extension fully inert
{
	await commands.get("memory")!.handler("off", mkCtx());
	const inert: any = await handlers.get("before_agent_start")!({ systemPrompt: "BASE", prompt: "how do I run the tests here" }, mkCtx());
	check("[15] disabled: no prompt injection", inert?.systemPrompt === "BASE" || inert === undefined);
	check("[15] disabled: no recall", inert?.message === undefined);
	const r15 = await handlers.get("tool_call")!({ toolName: "write", input: { path: memFileAbs, content: "x" } }, mkCtx());
	check("[15] disabled: no pause-gating of file tools", r15 === undefined);
}

// 16) pause persists across a session reload (state entry, last-one-wins)
{
	// [15] left the extension disabled — re-enable first.
	await commands.get("memory")!.handler("on", mkCtx());
	const probePaused = async () => {
		const r: any = await handlers.get("tool_call")!({ toolName: "write", input: { path: memFileAbs, content: "x" } }, mkCtx());
		return r?.block === true;
	};
	await pauseCmd.handler("", mkCtx()); // on
	await pauseCmd.handler("", mkCtx()); // off
	await pauseCmd.handler("", mkCtx()); // on
	await handlers.get("session_start")!({}, mkCtx());
	check("[16] pause state restored from last entry (on)", await probePaused());
	await pauseCmd.handler("", mkCtx()); // off again
	await handlers.get("session_start")!({}, mkCtx());
	check("[16] pause state restored from last entry (off)", !(await probePaused()));
}

// 17) Recall includes a prefix of a long memory and excludes later data.
{
	const longLines = Array.from({ length: LIMITS.recallMaxLines + 60 }, (_, i) => `entry-${i}-${crypto.randomUUID()}`);
	fs.writeFileSync(
		path.join(memRoot, slugDir, "long-memory.md"),
		"---\nname: long-memory\ndescription: very long memory\nmetadata:\n  type: reference\n---\n\n" +
			longLines.join("\n"),
	);
	const r17: any = await handlers.get("before_agent_start")!({ systemPrompt: "BASE", prompt: "tell me about the very long memory" }, mkCtx());
	const content = String(r17?.message?.content ?? "");
	check("[17] long memory recall is truncated", content.includes(longLines[0]) && !content.includes(longLines.at(-1)!));
}

// 18) atomic write leaves a complete file and no tmp leftovers
{
	const files18 = fs.readdirSync(path.join(memRoot, slugDir));
	check("[18] no .tmp leftovers after writes", files18.every((f) => !f.endsWith(".tmp")));
	const probe = parseMemory(fs.readFileSync(path.join(memRoot, slugDir, "long-memory.md"), "utf-8"));
	check("[18] source memory remains complete after recall", probe.body.trim().split("\n").length === LIMITS.recallMaxLines + 60);
}

// 19) final-audit regressions: disabled removes the tool, # stays inert,
//     /remember leaves no stale personal index line
{
	await commands.get("memory")!.handler("off", mkCtx());
	check("[19] disabled drops memory_save from active tools", !(pi.getActiveTools() as string[]).includes("memory_save"), JSON.stringify(pi.getActiveTools()));
	const r19a = await save.execute("t19", { name: "sneaky", type: "user", description: "d", body: "b" }, undefined, undefined, mkCtx());
	check("[19] disabled: memory_save execute errors", r19a.isError === true);
	const r19b: any = await handlers.get("input")!({ text: "# still works when enabled only", source: "interactive", images: [] }, mkCtx());
	check("[19] disabled: # shortcut stays plain text", r19b?.action === "continue");
	// re-enable for /remember check
	await commands.get("memory")!.handler("on", mkCtx());
	check("[19] re-enabled restores memory_save", (pi.getActiveTools() as string[]).includes("memory_save"));
	await commands.get("remember")!.handler("style-tabs.md", mkCtx());
	const idx19 = fs.readFileSync(path.join(memRoot, slugDir, "MEMORY.md"), "utf-8");
	check("[19] /remember leaves no stale personal line", !idx19.split("\n").some((line: string) => line.includes("](style-tabs.md)") && !line.includes("team/")), idx19.replace(/\n/g, " | "));
}

// 20) Provenance, UTF-8 truncation, recall selection, and shortcut behavior.
{
	const { readMemoryFile } = await import("../src/store.ts");
	const paths20 = { personalDir: path.join(memRoot, slugDir), teamDir: path.join(process.cwd(), ".pi", "memory") };

	// stampProvenance refresh via the write tool_result hook (HD/nQt port)
	const stampFile = path.join(paths20.personalDir, "stamped-probe.md");
	fs.writeFileSync(stampFile, "---\nname: stamped-probe\ndescription: probe\nmetadata:\n  type: user\noriginSessionId: session-old\nmodified: 2020-01-01T00:00:00.000Z\n---\n\nbody\n");
	await handlers.get("tool_result")!({ toolName: "write", input: { path: stampFile } }, mkCtx());
	const stamped20 = parseMemory(fs.readFileSync(stampFile, "utf-8"));
	check("[20] stamp preserves origin", stamped20.frontmatter.originSessionId === "session-old");
	check("[20] stamp advances modification time", Date.parse(stamped20.frontmatter.modified ?? "") > Date.parse("2020-01-01T00:00:00.000Z"));

	// UTF-8 clipping must respect byte boundaries and exclude excess body data.
	const wideFile = path.join(paths20.personalDir, "wide-probe.md");
	const character = "汉";
	const input = character.repeat(LIMITS.fileMaxBytes);
	fs.writeFileSync(wideFile, input);
	const wide20 = readMemoryFile(wideFile) ?? "";
	const prefix = /^汉*/u.exec(wide20)?.[0] ?? "";
	check("[20] UTF-8 body prefix fits the configured byte limit", prefix.length > 0 && Buffer.byteLength(prefix, "utf8") <= LIMITS.fileMaxBytes && prefix.length < input.length);

	// z4n single-token skip: a lone word skips recall even when it matches
	fs.writeFileSync(path.join(paths20.personalDir, "single-probe.md"), "---\nname: single-probe\ndescription: zzzprobe uniquewordalpha\nmetadata:\n  type: user\n---\n\nbody\n");
	const r20s: any = await handlers.get("before_agent_start")!({ systemPrompt: "BASE", prompt: "uniquewordalpha" }, mkCtx());
	check("[20] single-token non-CJK does not select the candidate", !String(r20s.message?.content ?? "").includes("zzzprobe.md"));
	const r20m: any = await handlers.get("before_agent_start")!({ systemPrompt: "BASE", prompt: "uniquewordalpha zzzprobe" }, mkCtx());
	check("[20] multi-word recall still fires", r20m.message !== undefined);

	// u$t edge cases: control chars rejected, leading-whitespace heading accepted
	const r20c: any = await handlers.get("input")!({ text: "# bad\u0007content", source: "interactive", images: [] }, mkCtx());
	check("[20] control chars rejected", r20c?.action === "continue");
	const r20w: any = await handlers.get("input")!({ text: "   # indented remember this", source: "interactive", images: [] }, mkCtx());
	check("[20] leading-whitespace heading transforms", r20w?.action === "transform");

}

// 21) Serialization round-trips and direct writes acquire provenance.
{
	const paths21 = { personalDir: path.join(memRoot, slugDir), teamDir: path.join(process.cwd(), ".pi", "memory") };

	// ps(): conforming names pass through; non-conforming ones hyphenate (incl. underscores).
	check("[21] ps conforming passthrough", slugName("already_slug") === "already_slug");
	check("[21] ps hyphenates non-conforming", slugName("Style_Tabs v2") === "style-tabs-v2");

	// serializeMemory + memory_save emit the Y7n canonical shape.
	const r21 = await save.execute("t21", { name: "canonical probe", type: "user", description: "d", body: "b" }, undefined, undefined, mkCtx());
	const raw21 = fs.readFileSync(path.join(memRoot, slugDir, "canonical-probe.md"), "utf-8");
	check("[21] save ok", !(r21 as { isError?: boolean }).isError);
	const parsed21 = parseMemory(raw21);
	check("[21] parser recovers saved provenance", parsed21.frontmatter.originSessionId === mkCtx().sessionManager.getSessionId() && Number.isFinite(Date.parse(parsed21.frontmatter.modified ?? "")));
	check("[21] legacy root stamp still reads", parseMemory("---\nname: x\ndescription: d\noriginSessionId: legacy\nmodified: 2020-01-01T00:00:00.000Z\n---\n\nb").frontmatter.originSessionId === "legacy");

	// HD fresh-stamp path canonicalizes a raw model-written file.
	const fresh21 = path.join(paths21.personalDir, "fresh-probe.md");
	fs.writeFileSync(fresh21, "---\nname: Fresh_Probe File\ndescription: probe\nmetadata:\n  type: user\n---\n\nbody\n");
	await handlers.get("tool_result")!({ toolName: "write", input: { path: fresh21 } }, mkCtx());
	const stamped21 = parseMemory(fs.readFileSync(fresh21, "utf-8"));
	check("[21] direct-write provenance is readable", stamped21.frontmatter.originSessionId === mkCtx().sessionManager.getSessionId() && Number.isFinite(Date.parse(stamped21.frontmatter.modified ?? "")));
}

// 22) extraction gates — $ln order (rUn -> oUn -> threshold) and cursor
//     consumption on skip; threshold skip keeps the cursor
{
	const { checkExtractionGates } = await import("../src/extract.ts");
	const v = (role: string, text: string) => ({ role, text, message: {} });

	// rUn short-circuits before the threshold gate, as in $ln.
	const g1 = checkExtractionGates([v("user", "hello there world")], 5, true);
	check("[22] direct-write gate consumes the window", !g1.run && g1.advanceCursor);
	// oUn skip consumes messages.
	const g2 = checkExtractionGates([v("assistant", "tool noise")], 1, false);
	check("[22] no-prose gate consumes the window", !g2.run && g2.advanceCursor);
	// Threshold skip (gates passed) keeps the cursor for the next event.
	const g3 = checkExtractionGates([v("user", "only one new")], 3, false);
	check("[22] threshold keeps cursor", !g3.run && !g3.advanceCursor);
	// All gates pass.
	const g4 = checkExtractionGates([v("user", "enough prose here")], 1, false);
	check("[22] gates pass", g4.run && g4.advanceCursor);
}

// Internal Dream turns must not recall otherwise-relevant stored memories.
{
	const { buildDreamPrompt } = await import("../src/extract.ts");
	const dream = buildDreamPrompt({ personalDir: memRoot, teamDir: null }, "sessions");
	const result = await handlers.get("before_agent_start")!({ systemPrompt: "BASE", prompt: dream }, mkCtx());
	check("internal Dream turn skips recall", result?.message === undefined);
}

// Leave tmp before removing it — Windows locks the process cwd's directory.
process.chdir(os.tmpdir());
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? "\nE2E ACCEPTANCE: ALL PASS" : `\nE2E ACCEPTANCE: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

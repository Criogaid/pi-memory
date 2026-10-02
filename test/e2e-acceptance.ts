/**
 * End-to-end acceptance test: drives the extension through a simulated pi
 * session lifecycle with a mock ExtensionAPI — the same events pi would fire,
 * in order — and asserts on observable behavior (files, prompts, blocking).
 *
 * Run: bun test/e2e-acceptance.ts
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

const handlers = new Map<string, Function>();
const tools = new Map<string, any>();
const commands = new Map<string, any>();
const entryRenderers = new Map<string, Function>();
const entries: any[] = [];
const pi: any = {
	on: (ev: string, fn: Function) => handlers.set(ev, fn),
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
			// buildContextEntries present — the extraction path must prefer it
			// over getBranch (compaction-aware, same as the model sees).
			buildContextEntries: () => branch,
			getBranch: () => {
				throw new Error("getBranch must not be used when buildContextEntries exists");
			},
			getEntries: () => entries,
			getSessionId: () => "sess-e2e",
		},
		model: { id: "mock-model" },
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
check("[2] # Memory section", sp.includes("# Memory"));
check("[2] ## MEMORY.md empty state", sp.includes("## MEMORY.md") && sp.includes("Your MEMORY.md is currently empty"));
check("[2] cc-memory section gated off by default", !sp.includes("## Citing memories"));
check("[2] no recall before any memory exists", r2.message === undefined);

// 3) memory_save writes file + index + frontmatter + provenance
const save = tools.get("memory_save")!;
const r3 = await save.execute("t1", { name: "Test Runner", type: "project", description: "run bun test", body: "Use `bun test`." }, undefined, undefined, mkCtx());
const savedFiles = fs.readdirSync(path.join(memRoot, slugDir)).filter((f) => f.endsWith(".md") && f !== "MEMORY.md");
const rawSaved = fs.readFileSync(path.join(memRoot, slugDir, savedFiles[0]), "utf-8");
check("[3] save returns success", r3?.content?.[0]?.text?.includes("Saved memory"), r3?.content?.[0]?.text ?? "");
check("[3] frontmatter type", rawSaved.includes("type: project"));
check("[3] provenance stamped", rawSaved.includes("originSessionId: sess-e2e"));
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
check("[5] reminder is system-reminder", String(r5?.message?.content ?? "").startsWith("<system-reminder>"));
check("[5] cc-memory instruction gated off", !String(r5?.message?.content ?? "").includes("<cc-memory"));
const r5b: any = await handlers.get("before_agent_start")!({ systemPrompt: "BASE", prompt: "how do I run the tests here" }, mkCtx());
check("[5] recall deduped on repeat", r5b?.message === undefined);

// 6) pause blocks writes into memory dirs only
const pauseCmd = commands.get("pause-memory")!;
await pauseCmd.handler({}, mkCtx());
const memFileAbs = path.join(memRoot, slugDir, savedFiles[0]);
const r6: any = await handlers.get("tool_call")!({ toolName: "write", input: { path: memFileAbs, content: "x" } }, mkCtx());
check("[6] write to memory blocked when paused", r6?.block === true, r6?.reason ?? "");
const r6b: any = await handlers.get("tool_call")!({ toolName: "write", input: { path: path.join(tmp, "normal.md"), content: "x" } }, mkCtx());
check("[6] normal write unaffected", r6b === undefined);
const r6c: any = await handlers.get("tool_call")!({ toolName: "memory_save", input: { name: "x", type: "user", description: "d", body: "b" } }, mkCtx());
check("[6] memory_save blocked when paused", r6c?.block === true);
await pauseCmd.handler({}, mkCtx()); // resume

// 6p) pause read-deny (c6) and write-deny (Si) carry their own messages
await pauseCmd.handler({}, mkCtx()); // pause again
const r6p: any = await handlers.get("tool_call")!({ toolName: "read", input: { path: memFileAbs } }, mkCtx());
check("[6p] read blocked with c6 message", r6p?.block === true && r6p.reason === "Cannot read memory while it is paused. Run /pause-memory to resume automemory.");
const r6q: any = await handlers.get("tool_call")!({ toolName: "write", input: { path: memFileAbs, content: "x" } }, mkCtx());
check("[6p] write blocked with Si message", r6q?.block === true && r6q.reason === "Cannot write to memory while it is paused. Run /pause-memory to resume automemory.");
await pauseCmd.handler({}, mkCtx()); // resume

// 6d) `#` memory shortcut transforms input (Claude Code u$t port)
const r6d: any = await handlers.get("input")!({ text: "# always deploy via the ops dashboard", source: "interactive", images: [] }, mkCtx());
check("[6d] # shortcut transforms", r6d?.action === "transform" && r6d.text.includes("memory_save"));
const r6e: any = await handlers.get("input")!({ text: "#!/usr/bin/env shebang is not a shortcut", source: "interactive", images: [] }, mkCtx());
check("[6d] #! not treated as shortcut", r6e?.action === "continue");
const r6f: any = await handlers.get("input")!({ text: "# a heading\n\nwith body text after it", source: "interactive", images: [] }, mkCtx());
check("[6d] # with following prose not a shortcut", r6f?.action === "continue");

// 7) agent_settled extraction with a mock model (branch long enough for the
//    default autoExtractMinMessages=6 gate); extraction must read entries via
//    buildContextEntries (mock getBranch throws)
for (const [role, text] of [
	["user", "please remember we prefer tabs over spaces in this repo"],
	["assistant", "noted"],
	["user", "also the build needs bun not npm"],
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
await commands.get("memory-extract")!.handler({}, extractCtx);
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

// 8b) dream command sends the consolidation prompt
await commands.get("dream")!.handler({}, mkCtx());
check("[8b] dream prompt sent", String(pi._sent ?? "").includes("Dream: Memory Consolidation") && String(pi._sent ?? "").includes("Reconcile memories against AGENTS.md"));

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
await pauseCmd.handler({}, mkCtx());
const r11: any = await handlers.get("input")!({ text: "# paused shortcut attempt", source: "interactive", images: [] }, mkCtx());
check("[11] paused # shortcut handled with notice", r11?.action === "handled");
// 11b) paused read of a memory file is blocked (Claude Code denies reads too)
const r11b: any = await handlers.get("tool_call")!({ toolName: "read", input: { path: path.join(memRoot, slugDir, "style-tabs.md") } }, mkCtx());
check("[11b] read of memory blocked when paused", r11b?.block === true);
await pauseCmd.handler({}, mkCtx()); // resume

// 12) /remember argument completion lists personal memories (pi API reuse)
const completions = commands.get("remember")!.getArgumentCompletions?.("") ?? null;
check("[12] /remember completions list personal memories", Array.isArray(completions) && completions.some((i: any) => i.value === "style-tabs.md"), JSON.stringify(completions?.map((i: any) => i.value)));

// 13) prompt carries the ported guidance sections (round-5 parity fixes)
{
	const { systemPrompt } = (await handlers.get("before_agent_start")!({ systemPrompt: "BASE", prompt: "hello" }, mkCtx())) as any;
	check("[13] link-liberally guidance present", systemPrompt.includes("Link liberally — a `[[name]]` that doesn't match an existing memory yet is fine"));
	check("[13] same-reply write discipline present", systemPrompt.includes("Check each reply before you send it"));
}

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
	const choice = `Turn pi-memory ${true ? "off" : "on"} for this session`;
	await commands.get("memory")!.handler("", { ...mkCtx(), hasUI: true, ui: { ...mkCtx().ui, select: async (_t: string, _items: string[]) => choice } });
	const inert: any = await handlers.get("before_agent_start")!({ systemPrompt: "BASE", prompt: "how do I run the tests here" }, mkCtx());
	check("[15] disabled: no prompt injection", inert?.systemPrompt === "BASE" || inert === undefined);
	check("[15] disabled: no recall", inert?.message === undefined);
	const r15 = await handlers.get("tool_call")!({ toolName: "write", input: { path: memFileAbs, content: "x" } }, mkCtx());
	check("[15] disabled: no pause-gating of file tools", r15 === undefined);
}

// 16) pause persists across a session reload (state entry, last-one-wins)
{
	// [15] left the extension disabled — re-enable first.
	const choice = `Turn pi-memory ${false ? "off" : "on"} for this session`;
	await commands.get("memory")!.handler("", { ...mkCtx(), hasUI: true, ui: { ...mkCtx().ui, select: async (_t: string, _items: string[]) => choice } });
	const probePaused = async () => {
		const r: any = await handlers.get("tool_call")!({ toolName: "write", input: { path: memFileAbs, content: "x" } }, mkCtx());
		return r?.block === true;
	};
	await pauseCmd.handler({}, mkCtx()); // on
	await pauseCmd.handler({}, mkCtx()); // off
	await pauseCmd.handler({}, mkCtx()); // on
	await handlers.get("session_start")!({}, mkCtx());
	check("[16] pause state restored from last entry (on)", await probePaused());
	await pauseCmd.handler({}, mkCtx()); // off again
	await handlers.get("session_start")!({}, mkCtx());
	check("[16] pause state restored from last entry (off)", !(await probePaused()));
}

// 17) recall read honors the 200-line cap with a line-reason note
{
	fs.writeFileSync(
		path.join(memRoot, slugDir, "long-memory.md"),
		"---\nname: long-memory\ndescription: very long memory\nmetadata:\n  type: reference\n---\n\n" +
			Array.from({ length: 260 }, (_, i) => `line ${i}`).join("\n"),
	);
	const r17: any = await handlers.get("before_agent_start")!({ systemPrompt: "BASE", prompt: "tell me about the very long memory" }, mkCtx());
	const content = String(r17?.message?.content ?? "");
	check("[17] 200-line recall cap with line reason", content.includes("long-memory.md") && content.includes(`first 200 lines`));
}

// 18) atomic write leaves a complete file and no tmp leftovers
{
	const files18 = fs.readdirSync(path.join(memRoot, slugDir));
	check("[18] no .tmp leftovers after writes", files18.every((f) => !f.endsWith(".tmp")));
	const probe = fs.readFileSync(path.join(memRoot, slugDir, "long-memory.md"), "utf-8");
	check("[18] file intact after staged writes", probe.startsWith("---") && probe.trimEnd().endsWith("line 259"));
}

// 19) final-audit regressions: disabled removes the tool, # stays inert,
//     /remember leaves no stale personal index line
{
	// disable via panel
	const off = `Turn pi-memory ${true ? "off" : "on"} for this session`;
	await commands.get("memory")!.handler("", { ...mkCtx(), hasUI: true, ui: { ...mkCtx().ui, select: async (_t: string, _items: string[]) => off } });
	check("[19] disabled drops memory_save from active tools", !(pi.getActiveTools() as string[]).includes("memory_save"), JSON.stringify(pi.getActiveTools()));
	const r19a = await save.execute("t19", { name: "sneaky", type: "user", description: "d", body: "b" }, undefined, undefined, mkCtx());
	check("[19] disabled: memory_save execute errors", r19a.isError === true);
	const r19b: any = await handlers.get("input")!({ text: "# still works when enabled only", source: "interactive", images: [] }, mkCtx());
	check("[19] disabled: # shortcut stays plain text", r19b?.action === "continue");
	// re-enable for /remember check
	const on = `Turn pi-memory ${false ? "off" : "on"} for this session`;
	await commands.get("memory")!.handler("", { ...mkCtx(), hasUI: true, ui: { ...mkCtx().ui, select: async (_t: string, _items: string[]) => on } });
	check("[19] re-enabled restores memory_save", (pi.getActiveTools() as string[]).includes("memory_save"));
	await commands.get("remember")!.handler("style-tabs.md", mkCtx());
	const idx19 = fs.readFileSync(path.join(memRoot, slugDir, "MEMORY.md"), "utf-8");
	check("[19] /remember leaves no stale personal line", !idx19.split("\n").some((line: string) => line.includes("](style-tabs.md)") && !line.includes("team/")), idx19.replace(/\n/g, " | "));
}

// 20) consistency-fix regressions: quality bar + full types XML in the
//     prompt snapshot, modified-stamp refresh, byte-accurate recall cap,
//     single-token recall skip, u$t edge cases, prompt texts
{
	const { buildExtractionPrompt, buildDreamPrompt } = await import("../src/extract.ts");
	const { readMemoryFile } = await import("../src/store.ts");
	const paths20 = { personalDir: path.join(memRoot, slugDir), teamDir: path.join(process.cwd(), ".pi", "memory"), configFile: "" };

	const r20: any = await handlers.get("before_agent_start")!({ systemPrompt: "BASE", prompt: "totally unmatched wording", source: "interactive" }, mkCtx());
	const prompt20: string = r20.systemPrompt ?? "";
	check("[20] quality bar in prompt", prompt20.includes("You must NOT save a memory unless you have validated that it is applicable, durable, AND legible."));
	check("[20] full types XML in prompt", prompt20.includes("<how_to_use>") && prompt20.includes("<scope>always private</scope>"));

	// stampProvenance refresh via the write tool_result hook (HD/nQt port)
	const stampFile = path.join(paths20.personalDir, "stamped-probe.md");
	fs.writeFileSync(stampFile, "---\nname: stamped-probe\ndescription: probe\nmetadata:\n  type: user\noriginSessionId: session-old\nmodified: 2020-01-01T00:00:00.000Z\n---\n\nbody\n");
	await handlers.get("tool_result")!({ toolName: "write", input: { path: stampFile } }, mkCtx());
	const stamped20 = fs.readFileSync(stampFile, "utf-8");
	check("[20] stamp keeps originSessionId", stamped20.includes("originSessionId: session-old"));
	check("[20] stamp refreshes modified", !stamped20.includes("2020-01-01") && /modified: 20\d\d-/.test(stamped20));

	// byte-accurate recall cap: 1400 CJK chars = 4200 UTF-8 bytes > 4096
	const wideFile = path.join(paths20.personalDir, "wide-probe.md");
	fs.writeFileSync(wideFile, "汉".repeat(1400));
	const wide20 = readMemoryFile(wideFile) ?? "";
	check("[20] byte cap names byte reason", wide20.includes("4096 byte limit"));
	check("[20] byte cap is real bytes", Buffer.byteLength(wide20.split("\n\n> ")[0], "utf-8") <= 4096);

	// z4n single-token skip: a lone word skips recall even when it matches
	fs.writeFileSync(path.join(paths20.personalDir, "single-probe.md"), "---\nname: single-probe\ndescription: zzzprobe uniquewordalpha\nmetadata:\n  type: user\n---\n\nbody\n");
	const r20s: any = await handlers.get("before_agent_start")!({ systemPrompt: "BASE", prompt: "uniquewordalpha" }, mkCtx());
	check("[20] single-token non-CJK skips recall", r20s.message === undefined);
	const r20m: any = await handlers.get("before_agent_start")!({ systemPrompt: "BASE", prompt: "uniquewordalpha zzzprobe" }, mkCtx());
	check("[20] multi-word recall still fires", typeof r20m.message?.content === "string" && r20m.message.content.includes("<system-reminder>"));

	// u$t edge cases: control chars rejected, leading-whitespace heading accepted
	const r20c: any = await handlers.get("input")!({ text: "# bad\u0007content", source: "interactive", images: [] }, mkCtx());
	check("[20] control chars rejected", r20c?.action === "continue");
	const r20w: any = await handlers.get("input")!({ text: "   # indented remember this", source: "interactive", images: [] }, mkCtx());
	check("[20] leading-whitespace heading transforms", r20w?.action === "transform");

	// prompt texts: explicit-remember in extraction, uUn tail + /remember in dream
	const ep20 = buildExtractionPrompt(paths20, "transcript", 3);
	check("[20] extraction explicit-remember line", ep20.includes("If the user explicitly asks you to remember something, save it immediately as whichever type fits best."));
	const dp20 = buildDreamPrompt(paths20, "sessions");
	check("[20] dream feedback-tail sentence", dp20.includes("framing is not evidence it's newer than AGENTS.md"));
	check("[20] dream /remember mention", dp20.includes("via `/remember`"));
}

// 21) canonical-shape regressions: Y7n serialization (node_type first, stamp
//     nested in metadata), ps() two-step slug, HD canonical re-stamp, dream
//     header (o6 + transcripts line, team block before the divider)
{
	const { slugName, parseMemory } = await import("../src/frontmatter.ts");
	const { buildDreamPrompt } = await import("../src/extract.ts");
	const paths21 = { personalDir: path.join(memRoot, slugDir), teamDir: path.join(process.cwd(), ".pi", "memory"), configFile: "" };

	// ps(): conforming names pass through; non-conforming ones hyphenate (incl. underscores).
	check("[21] ps conforming passthrough", slugName("already_slug") === "already_slug");
	check("[21] ps hyphenates non-conforming", slugName("Style_Tabs v2") === "style-tabs-v2");

	// serializeMemory + memory_save emit the Y7n canonical shape.
	const r21 = await save.execute("t21", { name: "canonical probe", type: "user", description: "d", body: "b" }, undefined, undefined, mkCtx());
	const raw21 = fs.readFileSync(path.join(memRoot, slugDir, "canonical-probe.md"), "utf-8");
	check("[21] save ok", !(r21 as { isError?: boolean }).isError);
	check("[21] node_type opens metadata", /^metadata:\n  node_type: memory$/m.test(raw21));
	check("[21] stamp nested in metadata", /^  originSessionId: sess-e2e$/m.test(raw21) && !/^originSessionId:/m.test(raw21));
	const parsed21 = parseMemory(raw21);
	check("[21] parser reads nested stamp", parsed21.frontmatter.originSessionId === "sess-e2e" && /^20\d\d-/.test(parsed21.frontmatter.modified ?? ""));
	check("[21] legacy root stamp still reads", parseMemory("---\nname: x\ndescription: d\noriginSessionId: legacy\nmodified: 2020-01-01T00:00:00.000Z\n---\n\nb").frontmatter.originSessionId === "legacy");

	// HD fresh-stamp path canonicalizes a raw model-written file.
	const fresh21 = path.join(paths21.personalDir, "fresh-probe.md");
	fs.writeFileSync(fresh21, "---\nname: Fresh_Probe File\ndescription: probe\nmetadata:\n  type: user\n---\n\nbody\n");
	await handlers.get("tool_result")!({ toolName: "write", input: { path: fresh21 } }, mkCtx());
	const stamped21 = fs.readFileSync(fresh21, "utf-8");
	check("[21] fresh stamp slugifies name", /^name: fresh-probe-file$/m.test(stamped21));
	check("[21] fresh stamp nests provenance", /metadata:\n  node_type: memory\n  type: user\n  originSessionId: sess-e2e\n  modified: 20\d\d-/.test(stamped21));

	// Dream header: o6 sentence + transcripts line; team block sits above the divider.
	const dp21 = buildDreamPrompt(paths21, "sessions");
	check("[21] dream o6 sentence", dp21.includes("This directory already exists — write to it directly with the write tool"));
	check("[21] dream transcripts line", dp21.includes("Session transcripts: `sessions` (large JSONL files — grep narrowly, don't read whole files)"));
	check("[21] dream team block before Phase 1", dp21.indexOf("## Team memory") !== -1 && dp21.indexOf("## Team memory") < dp21.indexOf("## Phase 1"));
	check("[21] dream AGENTS.md-rule wording", dp21.includes("or narrows an AGENTS.md rule with a stated reason"));
}

// 22) extraction gates — $ln order (rUn -> oUn -> threshold) and cursor
//     consumption on skip; threshold skip keeps the cursor
{
	const { checkExtractionGates } = await import("../src/extract.ts");
	const v = (role: string, text: string) => ({ role, text, message: {} });

	// rUn short-circuits before the threshold gate, as in $ln.
	const g1 = checkExtractionGates([v("user", "hello there world")], 5, true);
	check("[22] direct-write gate first", !g1.run && g1.reason.includes("directly") && g1.advanceCursor);
	// oUn skip consumes messages.
	const g2 = checkExtractionGates([v("assistant", "tool noise")], 1, false);
	check("[22] no-prose gate consumes", !g2.run && g2.reason.includes("prose") && g2.advanceCursor);
	// Threshold skip (gates passed) keeps the cursor for the next event.
	const g3 = checkExtractionGates([v("user", "only one new")], 3, false);
	check("[22] threshold keeps cursor", !g3.run && g3.reason.includes("threshold") && !g3.advanceCursor);
	// All gates pass.
	const g4 = checkExtractionGates([v("user", "enough prose here")], 1, false);
	check("[22] gates pass", g4.run && g4.advanceCursor);
}

// 23) prompt section — no() two-directory variants (Step 2 single-index
//     guidance, sensitive-data line, when-to-access bullet) and full Oe()
//     citing text
{
	const { buildMemoryPromptSection } = await import("../src/prompt.ts");
	const teamPaths = { personalDir: path.join(memRoot, slugDir), teamDir: path.join(process.cwd(), ".pi", "memory"), configFile: "" };
	const soloPaths = { ...teamPaths, teamDir: "" };

	const teamPrompt = buildMemoryPromptSection(teamPaths, true);
	check("[23] team Step 2 single-index line", teamPrompt.includes("The single `MEMORY.md` indexes both private and team memories — use a path like `file.md` for private memories and `team/file.md` for team memories"));
	check("[23] team sensitive line", teamPrompt.includes("- You MUST avoid saving sensitive data within shared team memories. For example, never save API keys or user credentials."));
	check("[23] team when-to-access bullet", teamPrompt.includes("- When memories (personal or team) seem relevant, or the user references prior work with them or others in their organization."));
	check("[23] citing example sentence", teamPrompt.includes("For example: <cc-memory filenames=\"testing-scripts.md\">From a previously saved memory, I see that the command to run tests in this project is `bun test`</cc-memory>"));

	const soloPrompt = buildMemoryPromptSection(soloPaths, false);
	check("[23] solo generic bullet", soloPrompt.includes("- When memories seem relevant, or the user references prior-conversation work."));
	check("[23] solo no sensitive line", !soloPrompt.includes("sensitive data within shared team memories"));
	check("[23] solo no team Step 2", !soloPrompt.includes("indexes both private and team memories"));
}

// 24) dream prompt — iEt verbatim wordings and the BFt "Additional
//     context" footer (tool constraints + sessions-since-dream list)
{
	const { buildDreamPrompt: bdp24 } = await import("../src/extract.ts");
	const p24 = { personalDir: path.join(memRoot, slugDir), teamDir: "", configFile: "" };
	const dp24 = bdp24(p24, "sessions", ["Fix login bug", "Refactor parser"]);
	check("[24] additional context header", dp24.includes("## Additional context"));
	check("[24] tool constraints paragraph", dp24.includes("**Tool constraints for this run:** Shell access is restricted to read-only commands"));
	check("[24] sessions list", dp24.includes("Sessions since last consolidation (2):\n- Fix login bug\n- Refactor parser"));
	const dp24b = bdp24(p24, "sessions");
	check("[24] no list no footer", !dp24b.includes("Additional context"));
	check("[24] transcript-search wording", dp24.includes("grep the JSONL transcripts for narrow terms"));
	check("[24] auto-memory section wording", dp24.includes("from your system prompt's auto-memory section"));
}

// 25) Vsr dream-turn exclusion — system-injected prompts don't trigger recall
{
	const { isDreamPrompt } = await import("../src/extract.ts");
	check("[25] dream prompt detected", isDreamPrompt("  \n# Dream: Memory Consolidation\n\nYou are performing a dream…"));
	check("[25] user prompt not flagged", !isDreamPrompt("help me consolidate my memories"));
	check("[25] built prompt carries header", (await import("../src/extract.ts")).buildDreamPrompt({ personalDir: memRoot, teamDir: "", configFile: "" }, "sessions").startsWith("# Dream: Memory Consolidation"));
}

// Leave tmp before removing it — Windows locks the process cwd's directory.
process.chdir(os.tmpdir());
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? "\nE2E ACCEPTANCE: ALL PASS" : `\nE2E ACCEPTANCE: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

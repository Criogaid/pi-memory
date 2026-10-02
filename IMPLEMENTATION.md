# Daily-use memory parity work

## Objective and scope

Improve daily-use parity with the Claude Code 2.1.252 reference while preserving pi's session and tool contracts. Implement the confirmed correctness repairs, branch-aware memory freshness, complete extraction input, and bounded Dream execution with durable completion state. Keep these notes current at each milestone; comments next to lifecycle and persistence code describe invariants rather than this work history.

Enterprise services, paid semantic retrieval, replacing pi's instruction loader, and reproducing Anthropic telemetry remain intentional differences. They are not prerequisites for the daily-use improvements requested here.

## Acceptance requirements

- Isolate projects by canonical full path, including same-basename projects. Preserve legacy directories; never automatically assign an ambiguous shared directory to a project.
- Resume extraction after direct writes and compaction. Restore cursor/pause state from the active branch. Respect pause and disable in every command and background path.
- Give saving, extraction, and promotion one mutation owner. Validate before writing, preserve existing data on rejected operations, reject promotion conflicts, and check pinned limits inside serialization.
- Resolve tool paths as pi does before pause checks and provenance stamping; enforce actual directory boundaries.
- Restore recall state from active session context, refresh changed/deleted memories, and avoid recalling memory for internal memory tasks. Preserve the stable system-prompt prefix.
- Supply complete memory rules and old bodies to extraction; prevent writes based on unread/truncated/stale old content. Bound input/output, cancellation, and background lifecycle.
- Run manual and opt-in automatic Dream through a restricted workflow. Record successful completion separately from memory modification time; guard overlapping runs and project/session transitions.
- Persist user settings, report meaningful task results, update README and PORT-MATRIX to match actual behavior, and leave reproducible regression checks.

## Milestones

| Milestone | Status | Evidence |
| --- | --- | --- |
| Baseline and design | Complete | Initial commit `159236d`; pi 0.85.1 docs and session-state example inspected; original E2E and strict check passed |
| Correctness and persistence | Complete | Nine regression cases failed before changes; all 14 current regressions plus original E2E, strict/no-unused TypeScript checks and diff checks pass |
| Recall state and freshness | Complete | 22 behavior regressions and cleaned lifecycle acceptance pass; real session branches/compaction drive recall restoration; freshness preserves the system prefix |
| npm toolchain | Complete | Locked pi 0.99.1 development dependencies (upgraded from 0.85.1); Node runner with pi's Jiti dependency; npm check and both test suites pass |
| Extraction workflow | Complete | 30 behavior regressions plus lifecycle acceptance; complete-body reads, parent context, stale-write rejection, cancellation, reload cursors, and sequential operations verified through public commands/events |
| Dream lifecycle and settings | Complete | 44 behavior regressions plus lifecycle acceptance pass; persisted switches, bounded session/evidence input, completion state, scheduling, cancellation, and cross-process ownership verified |
| Final audit and documentation | Complete | Acceptance audit below; strict/no-unused TypeScript checks, diff checks, dependency inspection, and local package preview passed; README and PORT-MATRIX match the implementation |

## Ownership and decisions

- `config.ts` owns project identity and resolved configuration; `store.ts` owns memory/index persistence and path containment.
- `recall.ts` owns relevance and surfaced-memory state. Session wiring stays in `index.ts`; `workflow.ts` owns bounded model execution and cancellation, reusing pi's model registry and file mutation queue.
- `dream.ts` owns scheduling, session sampling, and completion state. `persistence.ts` owns atomic project-switch updates and process-shared state locks; it does not lock independent foreground memory edits.
- Reuse the current validated operation protocol for extraction and Dream instead of starting an unrestricted secondary pi process. This keeps allowed effects explicit and makes cancellation/conflict behavior testable. Add bounded reads of existing memory where needed; no shell execution in memory jobs.
- Preserve existing legacy basename directories. New canonical-path identities prevent cross-project mixing; any legacy import must be deliberate and conflict-safe.
- File and index replacement can be atomic individually on the local filesystem. Multi-file persistence needs preflight, rollback on ordinary failures, and an explicit crash-recovery story; do not claim cross-file atomicity.

## Reference evidence

- `.references/claude-analysis/pretty/m0354.js:106546`: missing-cursor fallback (`nUn`, `oUn`).
- `.references/claude-analysis/pretty/m0354.js:106561`: direct-write scope ends at the consumed cursor.
- `.references/claude-analysis/pretty/m0354.js:106681`: restricted memory-job tools; `112561` carries full parent rules/context.
- `.references/claude-analysis/pretty/m0354.js:150849`: recall state derived from active attachments; `104794` handles stale reads.
- `.references/claude-analysis/pretty/m0354.js:107051`: Dream schedule; `87117` tracks consolidation separately and locks runs.
- `.references/claude-analysis/pretty/m1646.js:1042`: persisted Auto-memory and Auto-dream settings.
- Installed pi 0.85.1 `docs/extensions.md`, `docs/sessions.md`, and `docs/compaction.md` read in full. Follow `session-format.md` and relevant examples before session/workflow changes.

## Verification log

Commands: `npm run check`, `npm test`, `npx tsc -p tsconfig.json --noUnusedLocals --noUnusedParameters`, `git diff --check`, `npm ls --depth=0`, `npm pack --dry-run --json`.

First implementation milestone: 14 regression tests pass plus the original E2E acceptance script. Added real SessionManager compaction, parallel saves, pi builtin writes, path alias containment, conflict-safe promotion, explicit legacy import, and junction escape checks. Nine core cases failed against the initial code. All tests use temporary roots and mocked model completion.

`mutateMemory` now owns structured persistence. Sorted per-file queues prevent same-process interleaving; ordinary failures restore original bytes. Crash atomicity across several files and independent-process serialization are not claimed. The README records those limits.

Portable npm scripts and dev dependency declarations replace the machine-specific typeRoots path. Dependencies now use a standalone npm installation; no workspace type symlink is required.

## Completion and continuation

The daily-use acceptance requirements below are complete. Future changes should start from the owners and verified behavior recorded here and the intentional differences in PORT-MATRIX.md. Use npm, reuse Pi's public host APIs, and keep tests focused on observable behavior and data preservation.

## Recall milestone evidence and user constraints

Recall stores versioned revisions and byte usage on the actual injected custom message. Each turn restores them from `buildContextEntries`; pause and extraction cursors restore from `getBranch`. Snapshot and recalled files produce changed/deleted updates, while the system prefix stays fixed. File rendering and hashing use the same read snapshot. Budget exhaustion allows invalidation without additional bodies. Pins beyond the injected cap remain recall candidates.

The user explicitly prohibited literal-pinning and wording tests. Removed prompt prose, UI labels, YAML ordering, reason strings, and diagnostic phrasing assertions. Recall data-delivery tests use generated payloads. Keep behavior assertions only.

The user requires npm exclusively. Node's built-in test runner uses Jiti 2.7.0, also used by pi's extension loader. The lockfile pins a standalone development installation to pi 0.85.1. npm run check, npm test (22 regressions plus lifecycle acceptance), and the no-unused TypeScript check pass. The user also requires reuse of pi infrastructure; inspect public host APIs before implementing missing lifecycle behavior.

## Extraction milestone evidence

The workflow uses pi's `modelRegistry.complete`, `getSystemPrompt`, `buildContextEntries`, `serializeConversation`, `truncateTail`, and `withFileMutationQueue`. It owns only the restricted JSON read/apply protocol and its bounds; pi has no public fork entry point that enforces this protocol. Complete body reads populate observations checked inside the mutation queue. Updates preserve original provenance and omitted pin settings. Cursor and direct-write metadata follow active ancestry across reload.

Pause, disable, foreground turns, compaction, branch/fork/switch, and shutdown cancel jobs. A provider that ignores cancellation can finish later, but its response is discarded. Queued mutations check the signal before effects. A cancelled/failed batch may retain earlier committed operations; only fully completed extraction advances its cursor. Model session identifiers are isolated from the foreground conversation.

Verification: npm run check, npm test (30 regressions plus lifecycle acceptance), no-unused TypeScript checks, and git diff --check pass. Tests validate inherited context/data delivery, read-before-update enforcement, concurrent file preservation, cancellation, cursor restoration, and multi-operation persistence. No prompt wording assertions were added.

## Dream milestone decisions

`dream.ts` owns scheduling, bounded recent-session input, and a versioned completion record in personal memory. Successful no-op runs count as consolidation; failed, partial, and cancelled runs do not. The consumed timestamp is the start of a successful run so later session changes remain eligible. Successful sampling also consumes older omitted sessions. Automatic runs require elapsed time and new sessions; retries are throttled. Manual runs bypass cadence, not cancellation or locking.

The project switches `enabled`, `autoExtract`, and opt-in `autoDream` persist in `.pi/memory.json`; branch pause remains session metadata. `persistence.ts` uses Pi's per-file queue for settings and proper-lockfile (the library Pi uses internally) for cross-process state ownership. Existing unknown settings are preserved, and malformed settings are not overwritten. Dream reuses the existing restricted operation protocol, model registry, and mutation owner. Pi's settled hook awaits the work; this is not a detached daemon.

`/dream` runs through `MemoryJobs` outside the foreground transcript. `DreamRunner` reads live and saved contexts through Pi `SessionManager`, records attempts and completed runs under a process-shared lock, and cancels preflight as well as model work. Project evidence reads delegate to Pi `createReadTool` after canonical containment and file-size checks. Source writes and shell access remain unavailable.

Settings commands and the panel persist project switches, preserve unrelated fields, and keep running state unchanged when saving fails. Settled events serialize extraction then opt-in Dream, including when extraction is disabled. Panel completion dates come from the state record. Promotion/import now invalidate older model jobs after a successful write.

Final verification: npm run check and npm test pass (44 behavior regressions plus lifecycle acceptance). The no-unused TypeScript check passes. Dependency inspection resolves the standalone npm installation. The local package preview includes the new runtime modules and excludes hidden directories and temporary dependency backups. Git ignore checks cover root and nested dot-prefixed directories.

## Acceptance audit

| Requirement | Implementation and verified behavior |
| --- | --- |
| Project isolation and legacy preservation | Canonical project identity isolates same-basename roots; explicit import preserves source files and destination conflicts. |
| Extraction windows and branch state | Real Pi session compaction, reload, and branch changes verify cursor recovery, direct-write consumption, and branch-local pause. Explicit and automatic paths honor pause/disable. |
| Shared mutation ownership | Structured operations use `mutateMemory`; concurrent pin saves enforce capacity, rejected index updates preserve existing data, promotion preserves conflicts, and sequential batches see earlier committed writes. |
| Pi path semantics and boundaries | Builtin write aliases resolve consistently for pause and provenance; sibling directories remain accessible and escaping directory links are rejected. |
| Recall state and freshness | Visible session attachments restore deduplication/budgets; compaction restores eligibility; changed/deleted memories update context while the system prefix stays fixed. Internal Dream turns skip recall. |
| Complete extraction input and cancellation | Generated payloads verify inherited context and complete old-body delivery. Unread/stale updates are rejected, late responses cannot write after cancellation, and queued cancellation preserves earlier committed operations. |
| Dream lifecycle | Active/saved Pi contexts and native project reads supply evidence; no-op success advances completion, partial/failure/cancellation do not. Thresholds, retry/completion intervals, preflight cancellation, idle/session replacement, and a second Node process exercise scheduling and ownership. |
| Persisted settings and delivery | Reload restores project switches, unrelated fields survive, and malformed files leave disk/runtime state intact. Commands, panel, README, and PORT-MATRIX describe the implemented outcomes. |

Tests use temporary projects, real Pi session infrastructure, and a mocked model boundary. They verify lifecycle and data flow, not live-model memory quality or execution inside the original Claude Code binary. Verification ran on Windows with Pi 0.85.1. Multi-file crash atomicity and cross-process serialization of all memory edits remain documented limits.

## GitHub delivery

GitHub delivery is complete: the public [`Criogaid/pi-memory`](https://github.com/Criogaid/pi-memory) repository uses `main`, and local `main` tracks `origin/main`. Actions follow `../pi-hashline-edit`. The unscoped npm name belongs to another author; the package uses `@criogaid/pi-memory`, while the plugin and repository retain the `pi-memory` name.

CI runs the existing checks on Linux/macOS/Windows with Node.js 24 and on Linux with Node.js 22.19.0/26. Publish accepts matching stable version tags, repeats checks, and uses npm provenance with `NPM_TOKEN`. Actions are pinned to the inspected checkout v6.1.0 and setup-node v6.5.0 commits. Only workflow YAML files are exempted from the hidden-directory ignore rule. The package allowlist contains runtime sources and the linked user documentation; lockfile tarball URLs use the official npm registry without changing locked versions or integrity hashes.

Local verification passed: clean `npm ci` from the official registry, `npm run check`, all 44 regression tests, lifecycle acceptance, package preview (15 runtime/documentation files), and Git diff/ignore checks. The release guard accepts the current matching tag and rejects a mismatched tag. No Actions linter is installed; GitHub recognized both workflows and executed CI successfully.

Hosted verification: [CI run 37021928087](https://github.com/Criogaid/pi-memory/actions/runs/37021928087) passed all five jobs on commit `fc10a56b5be0c0854e0d4f994e11bc5243fb80a9`: Linux/macOS/Windows on Node.js 24, plus Linux on Node.js 22.19.0 and 26. Branch push triggered only CI; Publish remained inactive. Repository secret inspection found no `NPM_TOKEN`; configure it before the first npm release. No version tag was pushed and no npm publication was attempted.

## Workflow, provenance, and truncation regression coverage

Added 19 behavior cases to `test/regressions.test.ts` using the existing temporary-session and mock-model harness. Tests call `MemoryJobs.run` to inspect terminal outcomes and next-round read results. Provenance tests execute Pi write/edit tools and emit their lifecycle events. They preserve generated frontmatter values containing replacement metacharacters and verify nested type/pin metadata after inserting a timestamp. Truncation cases cover ASCII, multibyte characters, and surrogate pairs with four boundary alignments; the retained prefix must fit the requested 4096-byte limit and adding one more code unit must exceed it. No prompt or error wording is asserted.

Validation of the supplied business changes: `npm run check` passed; `git diff --check` passed. `npm test` ran 63 regressions: 62 passed and one failed, so its chained lifecycle script did not execute. Running the lifecycle script separately passed. An isolated copy of commit `02c3d48` with the new tests rejected 11 read/provenance cases; its path-boundary and truncation cases passed. Truncation is a behavior-preserving performance change, so the tests intentionally pass on both algorithms.

The regression commit `9dc5d92` retained a known failure for an escaping directory link with a missing target: the task returned `completed` instead of `failed`. Commit `d263ef4` separately fixed that boundary. The test remains enabled and passes in the full suite below.

## Persistent settings interaction

The one-shot `ui.select` panel closed after every change and exposed only enabled/automatic-extraction/automatic-Dream switches. Three behavior regressions reproduced those gaps before implementation. A fourth reproduction showed that reapplying unchanged settings cancelled extraction; only actual state transitions now invalidate jobs. `panel.ts` now composes Pi's `SettingsList`, `Container`, `Text`, theme adapter, and `ui.custom`, following Pi's tools-extension example. Pi owns selection, keyboard/mouse handling, scrolling, and dialog lifetime. Switch changes keep the selected row and panel open; pending writes disable activation, Escape waits for completion, and failure restores values from runtime state.

`config.ts` owns the shared command/list switch metadata. All six boolean settings use the existing persistence adapter; command completion and argument validation use that metadata. Pause remains branch-local and shares one mutation path between the panel and `/pause-memory [on|off]`. Scope and citation changes rebuild the prompt snapshot explicitly, while ordinary memory edits preserve its prefix. RPC/print mode reports state rather than attempting an unsupported terminal component.

The existing `.pi/memory.json` format remains the settings owner. Pi 0.99.1 exposes effective host settings for reading, but its public extension API does not provide a generic writer for this plugin-owned file. The adapter continues to use Pi's file mutation queue and its existing process-shared lock. No additional settings store or input-navigation implementation was introduced.

Final verification: all 70 regressions and lifecycle acceptance pass with `npm test`; `npm run check`, the no-unused TypeScript check, and `git diff --check` pass. Seven new behavior cases cover native panel rendering and repeated in-place toggles, rollback/retry, live feature switches, finishing a queued save before Escape closes the panel, command completion/idempotent pause, RPC/invalid-command handling, and preserving in-flight extraction when the same switch values are applied again. The lifecycle acceptance fixture passes string command arguments, matching Pi's public contract.

Installed-host verification: Pi 0.99.1 loaded the extension through its real RPC CLI in an isolated temporary project. `/memory` returned the current six-switch state without opening a terminal component; command discovery succeeded and stderr was empty. Terminal interaction tests exercise Pi 0.85.1's real SettingsList and renderer through a mocked UI boundary. No live-model request or personal-memory write was used.

## Pi 0.99 dependency upgrade

Development dependencies are pinned to pi 0.99.1 (typebox 1.3.27, matching pi), and the runtime peer range is `>=0.99.1 <0.100`. The upgrade exists so memory jobs can pass a provider-neutral thinking level: pi 0.85's public `ModelRegistry` exposes only provider-specific `complete` options, while 0.99 adds `completeSimple`/`streamSimple` with `reasoning`. Pi 0.99's tool path normalization (`utils/paths.js` `normalizePath`/`resolvePath`) was compared with `resolveToolPath` and matches; the helper is still not exported.

Verification: the Pi 0.99.1 test harness migration is complete; see [Model-selection regression evidence](#model-selection-regression-evidence) for the checks and coverage.

## Background job model selection

`extractModel` and `dreamModel` are optional `{ provider, model, thinkingLevel? }` selections in the existing settings files; `null` explicitly returns a job to the session model. `config.ts` owns parsing and shared labels, `persistence.ts` writes them through the existing queue/lock adapter, and `workflow.ts` resolves them through pi's `ModelRegistry.find`, `hasConfiguredAuth`, `getSupportedThinkingLevels`, and `clampThinkingLevel`. Like Claude Code's forked memory agents, which inherit the main loop's model and thinking configuration, jobs request models the way pi's agent does: always `ModelRegistry.streamSimple`, with `off` mapped to an omitted reasoning option. A job without an explicit level follows `pi.getThinkingLevel()` captured at job start, clamped to the job model. This keeps virtual models routable (`complete` rejects unrouted virtual models) and avoids the explicit thinking-off request that pi-ai 0.99.1's `streamSimple` sends when reasoning is absent while the session thinks (Google `thinkingBudget: 0`, which Gemini 2.5 Pro rejects). Unusable selections fall back to the session model or session thinking level and are reported as job notices rather than failing memory work.

The `/memory` panel adds two model rows. Activating one replaces the list with a search picker built from pi's `Input`, `SelectList`, and `fuzzyFilter`, following pi-codex-compaction's summary-model picker, then a thinking-level selection. The command reopens the panel afterwards. RPC/print summaries include the current selections.

Verification: the test handoff is complete; see [Model-selection regression evidence](#model-selection-regression-evidence).

## Model-selection regression evidence

The test harness supplies `ExtensionToolContext` to tool execution, mocks `ModelRegistry.streamSimple(...).result()` with typed model/message fixtures, and exposes a settable session thinking level; each recorded request carries the thinking it sent. Existing response sequences and cancellation remain covered, including abort-signal delivery and rejection of late writes. Both suites isolate the home directory before importing the plugin; Jiti captures namespace imports, so installing that mock after import does not isolate global configuration reads. Per-session memory and project files remain under temporary roots.

Added 25 regressions for foreground-model fallback, configured models and reasoning (including `off`), missing credentials/models, unsupported thinking, and notices preserved alongside model failures or Dream completion-write failures. Cache checks compare identity across repeated jobs, read rounds, job kinds, and sessions, and verify that requests do not disable caching. Configuration tests cover global/project precedence, trimming, invalid overrides, explicit `null`, reloads, preservation of unknown settings, and refusal to overwrite malformed files.

Job requests omit `maxTokens`, so pi-ai 0.99.1 uses `model.maxTokens` clamped to the remaining context (`api/simple-options.js`), matching Claude Code's memory agents, which use the model's default output limit and rely on the turn limit for cost. Thinking tokens count against `max_output_tokens`/`maxOutputTokens` on OpenAI and Google, so the former fixed 4096 cap could truncate reasoning replies. A reply with `stopReason: "length"` fails the job before parsing, without applying its operations. Two regressions cover the available output limit for both job kinds and truncation; both fail against the previous `workflow.ts`.

Native Pi widgets are driven through mock `ui.custom` and `ui.select` boundaries. Tests verify reopening with the selected model, immediate use by subsequent jobs, cancellation at either selection stage, session-model restoration, following the session thinking level, and preservation of the active selection after a save failure. RPC summaries and failure notifications preserve generated model identities and failure payloads. Assertions cover observable state, persistence, and data delivery; they do not pin prompt prose, UI labels, diagnostic wording, fixed defaults, or JSON layout.

Verification passed: `npm run check`; `npm test` (99 regressions and lifecycle acceptance); `npm run check -- --noUnusedLocals --noUnusedParameters`; `git diff --check`. A run of the session-thinking regressions against the `src/` before `24cc664` was not completed: that code calls `ModelRegistry.complete`, which the harness no longer provides, and one test then waited without a timeout.

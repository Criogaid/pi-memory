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
| npm toolchain | Complete | Locked pi 0.85.1 development dependencies; Node runner with pi's Jiti dependency; npm check and both test suites pass |
| Extraction workflow | Complete | 30 behavior regressions plus lifecycle acceptance; complete-body reads, parent context, stale-write rejection, cancellation, reload cursors, and sequential operations verified through public commands/events |
| Dream lifecycle and settings | Pending | Share the model/mutation boundary with extraction |
| Final audit and documentation | Pending | Audit every acceptance item against tests and final code |

## Ownership and decisions

- `config.ts` owns project identity and resolved configuration; `store.ts` owns memory/index persistence and path containment.
- `recall.ts` owns relevance and surfaced-memory state. Session wiring stays in `index.ts`; `workflow.ts` owns bounded model execution and cancellation, reusing pi's model registry and file mutation queue.
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

Commands: `npm run check`, `npm test`, `tsc -p tsconfig.json --noUnusedLocals --noUnusedParameters`, `git diff --check`.

First implementation milestone: 14 regression tests pass plus the original E2E acceptance script. Added real SessionManager compaction, parallel saves, pi builtin writes, path alias containment, conflict-safe promotion, explicit legacy import, and junction escape checks. Nine core cases failed against the initial code. All tests use temporary roots and mocked model completion.

`mutateMemory` now owns structured persistence. Sorted per-file queues prevent same-process interleaving; ordinary failures restore original bytes. Crash atomicity across several files and independent-process serialization are not claimed. The README records those limits.

Portable npm scripts and dev dependency declarations replace the machine-specific typeRoots path. In this environment `node_modules/@types` links to the existing matching pi workspace's types; the dependency directory remains ignored.

## Next action

Implement manual/automatic Dream and persisted settings on the bounded shared workflow. Reuse pi's SessionManager to load transcripts and public model/context/queue/lifecycle APIs. Do not reintroduce prompt or diagnostic wording tests. Use npm for all repository commands.

## Recall milestone evidence and user constraints

Recall stores versioned revisions and byte usage on the actual injected custom message. Each turn restores them from `buildContextEntries`; pause and extraction cursors restore from `getBranch`. Snapshot and recalled files produce changed/deleted updates, while the system prefix stays fixed. File rendering and hashing use the same read snapshot. Budget exhaustion allows invalidation without additional bodies. Pins beyond the injected cap remain recall candidates.

The user explicitly prohibited literal-pinning and wording tests. Removed prompt prose, UI labels, YAML ordering, reason strings, and diagnostic phrasing assertions. Recall data-delivery tests use generated payloads. Keep behavior assertions only.

The user requires npm exclusively. Node's built-in test runner uses Jiti 2.7.0, also used by pi's extension loader. The lockfile pins a standalone development installation to pi 0.85.1. npm run check, npm test (22 regressions plus lifecycle acceptance), and the no-unused TypeScript check pass. The user also requires reuse of pi infrastructure; inspect public host APIs before implementing missing lifecycle behavior.

## Extraction milestone evidence

The workflow uses pi's `modelRegistry.complete`, `getSystemPrompt`, `buildContextEntries`, `serializeConversation`, `truncateTail`, and `withFileMutationQueue`. It owns only the restricted JSON read/apply protocol and its bounds; pi has no public fork entry point that enforces this protocol. Complete body reads populate observations checked inside the mutation queue. Updates preserve original provenance and omitted pin settings. Cursor and direct-write metadata follow active ancestry across reload.

Pause, disable, foreground turns, compaction, branch/fork/switch, and shutdown cancel jobs. A provider that ignores cancellation can finish later, but its response is discarded. Queued mutations check the signal before effects. A cancelled/failed batch may retain earlier committed operations; only fully completed extraction advances its cursor. Model session identifiers are isolated from the foreground conversation.

Verification: npm run check, npm test (30 regressions plus lifecycle acceptance), no-unused TypeScript checks, and git diff --check pass. Tests validate inherited context/data delivery, read-before-update enforcement, concurrent file preservation, cancellation, cursor restoration, and multi-operation persistence. No prompt wording assertions were added.

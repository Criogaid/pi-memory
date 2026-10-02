# pi-memory

File-based persistent memory for pi, adapted from the Claude Code 2.1.252 reference in `.references/claude-analysis/`. This extension stores individual Markdown memories, maintains a `MEMORY.md` index, injects relevant memories, and extracts durable facts after an agent turn.

## Installation

Install one copy, globally or in the project:

```bash
npm ci
pi -e ./src/index.ts
# Or copy this directory to ~/.pi/agent/extensions/pi-memory/
```

Runtime peers are declared in `package.json`. Local verification uses pi 0.85.1. A second loaded copy stays inert and reports the duplicate.

## Storage and upgrading

Personal memories live under `~/.pi/agent/memory/<label>-<path-hash>/`. The label comes from the project basename; the SHA-256 key uses the canonical full path (case-normalized on Windows). Projects with the same basename have separate memory directories. A theoretical hash collision is possible; the key is not a user-supplied identifier.

Version 0.3 changes the directory identity. Old basename-only directories are preserved and are never automatically assigned to one project: they may already contain memories from several projects. When a legacy directory is detected, the extension displays its path. Inspect it, then run `/memory import-legacy` to copy its valid personal memories into the current project. Existing destination files are skipped, and the source is preserved. Review mixed-project legacy content before importing it.

With `sharedMemory: true`, team memories live in `<project>/.pi/memory/`. The personal `MEMORY.md` indexes both roots, with `team/` references for team files. This repository's `.gitignore` excludes all dot-prefixed directories; sharing `.pi/memory` through Git in another project requires that project's ignore rules to allow it.

## Commands and tools

| Entry point | Behavior |
| --- | --- |
| `memory_save` | Save one typed memory and update its index entry. |
| `# <fact>` | Transform an interactive memory shortcut into a request to use `memory_save`. |
| `/memory` | Open the panel with settings and last successful Dream time, or report stats in noninteractive mode. |
| `/memory on` / `/memory off` | Persist the project enable switch. |
| `/memory auto-extract on\|off` / `/memory auto-dream on\|off` | Persist the corresponding automatic-work switch. |
| `/memory import-legacy` | Explicitly copy legacy personal memories, preserving conflicts and source files. |
| `/pause-memory` | Toggle branch-local pause. Memory reads/writes, extraction, promotion, and Dream are denied while paused. |
| `/memory-extract` | Request extraction now, bypassing automatic frequency gates but respecting pause/disable. |
| `/remember <file.md>` | Promote a personal memory to team memory. Refuse an existing team destination; merge or rename it first. |
| `/dream` | Run restricted consolidation using recent Pi session context and optional read-only project evidence. |

A memory contains a name, description, `metadata.type` (`user`, `feedback`, `project`, `reference`), optional pin, provenance, and a Markdown body. The main prompt carries the four memory-type descriptions, scope guidance, quality criteria, and the negative list of facts that should not be saved.

## Behavior and guarantees

The system prompt snapshots the index and pinned memories at session start to preserve its cache prefix. Recall supplies relevant content on later user turns. Changed or deleted memories already supplied through the snapshot or recall produce updates, including on short prompts. Memory jobs run outside the foreground transcript; legacy injected Dream prompts remain excluded from ordinary recall.

The keyword selector uses stemming, full-width character folding, CJK fragments, and weak body matches. Recall revisions and byte usage are stored with injected messages and restored from the active visible context. Branch changes and compaction therefore restore eligibility when an attachment is no longer visible. Limits are defined in [`LIMITS`](src/config.ts): index loading is capped at 200 lines / 25,000 characters; memory recall at 200 lines / 4,096 bytes; the context recall budget is 61,440 bytes; at most four pinned memories are injected. Up to five recalls or freshness updates are sent per turn. Budget exhaustion still permits invalidation notices without file bodies. Pins beyond the initial four remain eligible for recall. `memory_save` additionally enforces body, index, and pinned limits on writes.

Structured saving, extraction, deletion, and promotion share one mutation owner. It validates index capacity before replacing content, checks the latest pinned count inside serialization, and rejects promotion conflicts. Built-in writes and edits share pi's per-file queue with structured writes and provenance stamping. Relative paths, home expansion, and directory boundaries are resolved before pause checks.

Individual file replacement uses a temporary file followed by rename. Ordinary multi-file failures restore previously modified files to their original bytes; rollback failure is reported explicitly. This is not a cross-file crash transaction: a process/OS crash between renames can leave a memory and its index out of sync. Memory mutation queues serialize operations within one Pi process. Dream state and settings additionally use cross-process locks, but those locks do not serialize independent foreground memory edits. Keep a backup or version history when editing shared memories.

Automatic extraction skips a turn that already wrote memory directly, then resumes for later turns. The consumed cursor survives reload; a missing cursor after compaction falls back to visible history. The current threshold counts new messages; the reference counts qualifying events.

Extraction uses pi's model registry, effective parent prompt, conversation serialization, truncation utility, and file queue. Its restricted JSON workflow can request complete old memory bodies before proposing changes. Unread, oversized, or concurrently changed memories cannot be overwritten. Updates preserve origin provenance and omitted pin settings. The workflow bounds model turns, response size, context size, and elapsed time; pause, disable, session transitions, compaction, and a new foreground turn cancel pending work. Each operation is independently committed, so a partial result retains successful earlier operations and leaves the extraction cursor unchanged.

Dream shares the restricted model workflow and its cancellation guarantees. It uses Pi's `SessionManager` to reconstruct the active context and up to four recently changed saved sessions. Each excerpt is capped at 8,000 bytes; older sessions outside that sample are omitted. A successful run advances its consumed-time watermark to the run's start, so later session changes remain eligible. Project evidence reads use Pi's read tool with its truncation notices, are confined to the canonical project root, and require regular text files no larger than 1,000,000 bytes. Dream cannot run shell commands, write source files, or create/promote team memories. See the bounds in [`dream.ts`](src/dream.ts) and [`workflow.ts`](src/workflow.ts).

Automatic Dream is opt-in. After a settled foreground turn, extraction runs first if enabled, then Dream checks for at least five changed sessions and at least 24 hours since its last successful run. Attempts are throttled to ten-minute intervals. Manual `/dream` bypasses those cadence gates. Pi awaits the settled hook; there is no detached daemon. The shared workflow allows five model turns within 60 seconds, and Dream also bounds preflight wait to 70 seconds. A no-op run records success; partial, cancelled, and failed runs preserve earlier writes without advancing completion. The personal directory's versioned `.dream-state.json` holds actual attempt/completion timestamps, independent of memory mtimes.

## Configuration

Read from `~/.pi/agent/memory/config.json`, then `<project>/.pi/memory.json`. `PI_MEMORY_DIR` overrides `memoryDir`. Relative memory roots resolve against the project directory.

```json
{
  "memoryDir": "~/.pi/agent/memory",
  "enabled": true,
  "autoDream": false,
  "sharedMemory": false,
  "autoExtract": true,
  "autoExtractMinMessages": 1,
  "recall": true,
  "citeMemories": false
}
```

The defaults live in [`config.ts`](src/config.ts). Panel and command changes to `enabled`, `autoExtract`, and `autoDream` are written to the project's `.pi/memory.json` and restored on session start. Unknown configuration fields are preserved; invalid existing files are not overwritten. Other running Pi instances load saved changes on their next session start. Pause remains local to the selected session branch. `citeMemories` adds the reference's `<cc-memory>` citation instruction. `PI_MEMORY_DEBUG=1` enables local debug messages.

## Reference parity

[`PORT-MATRIX.md`](PORT-MATRIX.md) distinguishes copied prompt material, adapted behavior, and missing mechanisms. A matching message or constant does not establish lifecycle parity.

Intentional differences include keyword retrieval instead of a paid model selector, local files instead of enterprise stores/synchronization, Pi's `AGENTS.md` loader instead of Claude Code's instruction hierarchy, and Pi session contexts instead of reference activity logs. Dream uses bounded excerpts and structured operations rather than a general tool-using fork. The completed acceptance audit and implementation decisions are recorded in [`IMPLEMENTATION.md`](IMPLEMENTATION.md).

## Development

Use Node.js 22.19 or newer. Tests use Node's test runner and the same Jiti TypeScript loader dependency as pi. Install the locked dependencies with npm:

```bash
npm ci
npm run check
npm test
```

The regression suite drives real Pi sessions with a mocked model boundary. It covers project isolation, extraction after direct writes/compaction, branch-aware pause and recall, save/promotion preservation, concurrent mutation, inherited context, Dream scheduling/cancellation, actual completion records, persistent settings, scoped project reads, and cross-process Dream ownership. The lifecycle acceptance script also runs. Tests check behavior and data preservation without pinning prompt text, UI labels, defaults, or diagnostic wording. No live model credentials or personal memory directories are required.

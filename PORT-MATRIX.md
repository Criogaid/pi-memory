# Reference parity matrix

Reference: extracted Claude Code 2.1.252 sources under `.references/claude-analysis/`. Line references locate behavior in the bundled snapshot, not a public API. The reference has feature-gated branches; not all mechanisms run for every user.

Use **copied** for prompt text/constants, **adapted** for equivalent intent through pi, **partial** for missing behavior, and **omitted** for an intentional scope difference. A copied helper does not prove its callers or lifecycle match.

| Area | Reference evidence | Current behavior | Status |
| --- | --- | --- | --- |
| Project identity | `modules/m0136_807622.js:54`, `pretty/m0169.js:2785` | Canonical full-path key under the pi personal root; explicit conflict-safe legacy import | Adapted |
| Memory frontmatter | `pretty/m0169.js` `Wr`, `Y7n`, `ps`; `pretty/m0354.js` `HD` | Strict YAML parse with lenient fallback, normalized serialization and provenance stamping | Adapted |
| Four types and quality rules | `pretty/m0169.js` `mLe`, `Wyt`, `Ps` | Type blocks in `types-text.ts`; main prompt includes quality/negative-list rules | Copied text, adapted tool names |
| Index loading | `pretty/m0169.js:2411` `Q5e` | Session-stable index snapshot and truncation warning | Adapted |
| Save/index mutation | Reference file mode uses two tool writes; enterprise writes are server-managed | `store.ts` validates and serializes structured writes with ordinary-failure rollback | Plugin contract |
| Pinned injection | `pretty/m0354.js:157330` `KHt` | Four injected pins; plugin additionally enforces a write cap | Adapted; write cap is not a reference storage invariant |
| Direct-write extraction gate | `pretty/m0354.js:106561`, `106764` | Consume the current window and clear direct-write state | Adapted |
| Missing extraction cursor | `pretty/m0354.js:106546`, `106602` | Fall back to visible messages after compaction/branch cursor loss | Adapted |
| Extraction frequency | `pretty/m0354.js:106787` | Counts messages instead of qualifying events | Partial |
| Extraction context and tools | `pretty/m0354.js:106681`, `112561` | Single JSON call with compact rules and memory descriptions; no old-body reads | Partial |
| Extraction cancellation/coalescing | `pretty/m0354.js:106839` | Local coalescing exists; full job lifecycle/draining is not restored | Partial |
| Recall ranking | `pretty/m0354.js:149547` `LBt`, `149631` `Ssr` | Keyword/stem/CJK scoring | Intentional substitute |
| Recall prefetch | `pretty/m0354.js:150887` `z4n` | Synchronous recall during `before_agent_start` | Omitted |
| Internal Dream recall exclusion | `pretty/m0354.js:150885` `Vsr` | Dream prompt detection is wired into recall | Adapted for the current injected task |
| Recall freshness/state | `pretty/m0354.js:104794`, `150849` | Message revisions/budget restore from visible context; changed/deleted snapshot and recalled content refresh | Adapted |
| Seeded unchanged reads | `pretty/m0354.js:117872` | No shared read-state cache with pi's read tool | Omitted |
| Pause | `pretty/m0169.js:9669`; `pretty/m0354.js:92635` | Selected ancestry restores pause; resolved tool paths and structured commands respect it | Adapted |
| Memory panel | `pretty/m1646.js:1042` | Session toggles, manual extract/dream, open folders | Partial; no persisted Auto-dream switch/true last-run status |
| Dream prompt | `pretty/m0354.js:106900` `iEt` and team/AGENTS reconciliation | Four-stage guidance adapted to pi transcripts | Adapted text |
| Dream execution | `pretty/m0354.js:107051`, `87117` | Manual main-conversation prompt plus approximate reminder based on memory mtime | Partial; no restricted task, cross-process lock, or actual completion record |
| `/remember` | Referenced in Dream guidance; no matching command implementation located in the bundled registration examined | Plugin promotion with conflict/pause checks | Plugin contract |
| Enterprise tools/stores | `report/05-记忆工具与召回注入.md` and corresponding `m0354` tools | Local personal/team files, no remote store/version-token API | Omitted |
| Instruction hierarchy | `report/03-CLAUDE.md体系.md` | pi owns AGENTS.md loading | Host responsibility |
| Activity logs | `report/02-自动记忆层.md` | pi session JSONL | Intentional substitute |
| Command aliases, aggregate footer, telemetry | Reference command/UI paths | Basic pi status and local debug output | Omitted |

## Verification

`npm run check` type-checks the plugin and tests. `npm test` runs observable-behavior regressions and the original lifecycle acceptance script. Tests verify the local implementation, not execution inside the original Claude Code binary. Implementation progress and remaining acceptance requirements live in `IMPLEMENTATION.md`.

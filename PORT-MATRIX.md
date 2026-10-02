# 移植核对矩阵

插件导出 ↔ Claude Code v2.1.252 原版函数的对照与验证深度。状态只反映**截至 2025-10-02 的验证深度**，不是永久属性。

**状态定义**

| 标记 | 含义 |
|---|---|
| ✅ 已逐字核对 | 直接打开 `claude-analysis/pretty/`（m0169/m0354 等 7 个模块）对该行为做过逐字/逐常量比对 |
| 📄 按报告核对 | 与 `claude-analysis/report/` 的描述一致，原版函数源码不可得或未打开 |
| 🛠 插件自创 | 无原版对应，或明确替代原版机制（README 移植表/省略表已声明） |
| ⛔ 省略 | 原版有、插件未实现（见文末省略清单） |

行号引用为验证时点的 beautified 源码位置，仅作定位提示。

## config.ts

| 导出 | 原版对应 | 状态 | 备注 |
|---|---|---|---|
| `MEMORY_INDEX` | `IFe`（"<auto-memory-index>"，m0354:157177）及 MEMORY.md 索引机制 | ✅ | 索引文件名逐字 |
| `LIMITS` | `VD`=200 / `VF`=25000 / `jEe`=200 / `ZX`=4096（m0169）；`Ksr` slice(0,5)、`Zgr`=61440、`G0`=4（m0354） | ✅ | 全部逐字；150 字符钩子经 `iEt` Phase 4 逐字证实；`extractMaxOps`=6 🛠（插件特定） |
| `MemoryType` / `MEMORY_TYPES` | 四类型清单（mLe/Wyt） | ✅ | 逐字 |
| `MemoryConfig` / `loadConfig` / `resolvePaths` / `expandHome` | —（CC 用客户端设置 + 实验开关） | 🛠 | `autoExtractMinMessages`=1 默认已逐字证实 = `tengu_bramble_lintel ?? 1`（m0354:106775） |
| `projectSlug` | `so()`（m0169） | ✅ | 逐字 |

## store.ts

| 导出 | 原版对应 | 状态 | 备注 |
|---|---|---|---|
| `MemoryFileInfo` | `Lin()` 记录（m0354:3969） | 🛠 | pi 侧结构；字段语义对齐（mtimeMs/metadata.pinned/metadata.modified） |
| `ensureDirs` / `indexPath` / `deleteFileSafe` / `readFileOrNull` | — | 🛠 | 基础设施 |
| `listMemories` | `Lin()`（m0354:3969） | ✅ | mtimeMs desc 排序、metadata.pinned/modified 读取逐字；正文弱信号 100 上限为插件值（CC 选择器扫描上限 `Pqt`=200） |
| `readIndex` / `truncateIndex` | `Q5e(e, t)`（m0169:2411） | ✅ | 逐字：200 行/25000 单位、换行边界回退、index 与 memory 双 kind 警告 |
| `readMemoryFile` | `chr()` / `RB`（m0354:150860） | ✅ | 逐字：真 UTF-8 字节、单原因标注（字节优先）、200 行 |
| `formatIndexLine` | 行形状：`iEt` Phase 4 + `Wr` 模板（m0169:1829 / m0354:106955） | ✅ 形状 | `- [Title](file.md) — one-line hook` 与 ~150 字符钩子逐字证实；程序化生成器 🛠（CC 本地模式由模型自写索引行，程序化索引维护属企业服务端） |
| `upsertIndexLine` / `removeIndexLine` | 两步保存约定的索引维护 | 🛠 | 链接目标锚定解析为插件强化（README 已列） |
| `writeFileSafe` | —（CC 本地写入走 Write/Edit 工具层原子性） | 🛠 | tmp+rename 为插件自建；旧注释误引 `t4`（实为 team-store manifest 逻辑），已更正 |
| `countPinned` | `r$e().pinnedCount`（m0354:3898） | ✅ | 逐字 |

## frontmatter.ts

| 导出 | 原版对应 | 状态 | 备注 |
|---|---|---|---|
| `MemoryFrontmatter` / `ParsedMemory` / `parseMemory` | 键结构 `us`/`fs`（m0169:1750–1770）；嵌套读取对齐 `ede`（读 `metadata.originSessionId`/`metadata.modified`） | ✅ | 键结构与戳记层级逐字；严格解析+宽松回退实现 🛠；旧版根层戳记文件保留回退读取 |
| `serializeMemory` | `Y7n()`（m0169:1809） | ✅ | 规范形状：`ps` slug、`node_type: memory` 首键、戳记嵌套 metadata（`K7n`）、根层多余键丢弃；body 只剥前导空行 |
| `slugName` | `ps()`（m0169:1807） | ✅ | 两步逻辑逐字：`ds` 合格直通，否则小写+连字符化（下划线随之折叠） |
| `stampProvenance` | `HD()` / `Y7n` / `K7n` / `nQt`（m0354:24705） | ✅ | 无戳路径 = 规范化重序列化（对齐 HD）；有戳路径 = `nQt` 原位刷新（嵌套与根层均适用） |

## prompt.ts

| 导出 | 原版对应 | 状态 | 备注 |
|---|---|---|---|
| `buildMemoryPromptSection` | `no()` 全函数（m0169:2367–2412）+ 段常量 `Lt`/`Be`/`Y5e`/`lt`/`tde`/`Oe`/`uLe`/`hLe`/`st`/`ft`/`jt`（1865–2366） | ✅ | 逐段逐字：双目录句、build-up 句、remember/forget、类型块、What-NOT-to-save、敏感行（team 时，本轮补原句）、两步保存（Step 1 目录选择、Step 2 双目录单索引指引——本轮补、4096 行、4 条 upkeep）、When-to-access（含两目录首 bullet 变体——本轮补与 staleness `Y5e`）、Before-recommending `tde`、Citing `Oe` 完整版含示例（本轮补）、持久化边界段；`Ps` 三准则/lessons/"Check each reply" 段源自同文件 stone_shell 变体（2294/2304，已文档化混用）；scope 段位置与 team bullet 尾句为 pi 适配（无 sync 机制） |
| `buildIndexSection` | `oo()`（m0169:2537） | ✅ | `## MEMORY.md` 标题与空索引文案逐字 |
| `buildPinnedSection` | `KHt`（m0354:157330）/ `HHt`（158037）/ `flr` / `G0`=4 | ✅ | 逐字：`<pinned-memory>` 标签、`Q5e(content,"memory")` 截断、空/不可读剔除、mtimeMs 排序 |

## recall.ts

| 导出 | 原版对应 | 状态 | 备注 |
|---|---|---|---|
| `RecallSession` | `lhr()`（m0354:150849）+ `Zgr.MAX_SESSION_BYTES`=61440（149739） | ✅ | 语义逐字：去重路径集 + 按 `.length` 计费；容器为 pi 侧实现 |
| `recallForPrompt` | `z4n` 全函数（m0354:150885–150935）+ `Ksr`/`chr`/`k9`/`N2e` | ✅ | 触发门逐字：预算入口检查、单 token 跳过（CJK 例外；无 `fNe` 开关、恒开启）；本轮补 `Vsr` 系统事件排除——`/dream` 注入回合不触发召回（`isDreamPrompt`）；compact/prompt_suggestion/agentId 在 pi 无对应物；≤5、截断、头部布局逐字；选择打分见下行 |
| （非导出）`scoreMemory` / `tokenize` / `stem` | 替代 `LBt` 索引检索（m0354:149547）/ `Ssr` 模型选择器（149631） | 🛠 | 权重自创，README 省略表已声明；全角折叠为附加强化 |
| `RecallResult` | — | 🛠 | |

## extract.ts

| 导出 | 原版对应 | 状态 | 备注 |
|---|---|---|---|
| `collectEntriesSince` / `EntryView` | 游标 `r`（末条消息 uuid，m0354:106766）；计数 = `nUn`（user/assistant 条目，m0354:106546） | ✅ | 逐字 |
| `checkExtractionGates` | `rUn`/`oUn`/`rEt`/`nEt`/`tEt`/`nUn`（m0354:106546–106800） | ✅ | 函数体全部逐字：直写 = memory 工具成功结果或 Write/Edit 落在记忆目录内（**不限 .md**，`aN` 纯目录判定）；散文 = 非 meta 用户消息 ≥3 个空白分词；门序 rUn→oUn→阈值；两个 skip 消费消息（游标推到末条 uuid），阈值 skip 不消费（本轮修复对齐）；保留差异：阈值按消息数 vs 原版按事件数（默认 1 等价） |
| `containsSecret` | —（本地模式无；企业 store 服务端有） | 🛠 | 插件加固，README 已标注 |
| `ExtractOp*` / `parseExtractResponse` | `eEt()` 受限子代理的工具循环 | 🛠 | JSON 单次调用协议自创（省略表已声明） |
| `normalizeContent` | `qF()`（m0169:1741） | ✅ | 逐字：EOL 规范 + C0/C1（除 Tab/LF）→ U+FFFD |
| `flattenIndexLine` | — | 🛠 | |
| `applyExtractOps` | 企业 `memory_write` 服务端校验 | 🛠 | 守卫常量 ✅（同 LIMITS）；op 执行面自创 |
| `buildExtractionPrompt` | `eEt()`（m0354:106524–106545） | ✅ 文本／🛠 协议 | 函数体全展开：开头句/“~N messages”/“waste any turns…no git commands”/现有文件块与尾句/remember/forget 两变体/Apply-句逐字；"Nothing to save." 改写为空 ops 指令，工具清单与 turn-budget 段属工具循环（已省略），Apply-句改指内联规则（单次调用无系统提示词）；条目行格式自创 |
| `buildDreamPrompt` | `iEt()` 全函数（m0354:106900–106958）+ 调用点 `BFt`（107120–107135）+ `cUn`/`uUn`/`o6` | ✅ | 逐行对照完成：标题/引言/四阶段（含 ~200 chars 降级行、~25KB、200 行）/150 字符行形状/对账段/team 段/目录句/transcripts 行逐字；本轮补："grep the JSONL transcripts" 原词、"auto-memory section" 原词、`BFt` 尾部 "## Additional context"（工具约束段 + "Sessions since last consolidation" 列表，会话名取自 pi SessionManager，按 dreamTimestamp 过滤；约束段为提示文本，无强制执行）；logs 目录 → pi 会话 JSONL、team 段 "sessions"/"subtree" 用词为文档化适配；`d`（skipIndex 企业变体）与 `y`（工具不可用注）两分支未启用（本地模式不触发） |

## types-text.ts

| 导出 | 原版对应 | 状态 | 备注 |
|---|---|---|---|
| `TYPES_WITH_SCOPE` | `mLe`（m0169） | ✅ | 脚本机械提取（`.agent-tools/extract-memory-types.ts`），零手改 |
| `TYPES_WITHOUT_SCOPE` | `Wyt`（m0169） | ✅ | 同上 |

## index.ts（唯一导出：`default` 组合根 🛠）

组合根本身为插件接线；其承载的行为映射：

| 处理器 / 行为 | 原版对应 | 状态 | 备注 |
|---|---|---|---|
| `session_start` 提示词快照 | `Mn()`/`no()` 段序（m0169:2367/2525） | ✅ | 段序对照完成：与 `Mn` 一致，除两处已文档化差异——stone_shell 的 lessons/三准则/"Check each reply" 段插在 remember/forget 之后（原文在 m0169:2294/2304，插件逐字一致）；scope 段后移（本地无 sync 机制，尾句适配）；快照不回写、新鲜度靠 recall 的设计按报告 06 |
| `before_agent_start` 注入 | `z4n` 附件管线 | ✅ | 同步注入替代异步预取（见省略） |
| `input` `#` 快捷键 | `u$t` / `Z8t` / `eQt`（m0354:24692） | ✅ | 逐字：首行 trim、`#!` 排除、多行正文排除、C0/C1 拒绝（`eQt` 源码已直接对照） |
| `tool_call` 暂停拦截 | `Si`（写拒绝，m0169:8592）+ `c6`（读拒绝，m0169:9674）+ `tzt`（m0169:1711） | ✅ | 本轮补齐：暂停同时拦截 Read（独立读文案逐字）与写（写文案逐字）；`read` 本在拦截集合内但此前用通用文案；`/pause-memory` 通知用 `tzt` 逐字 |
| `tool_result` 直写标记 + 来源戳 | `rUn`（m0354:106561）+ `HD`（m0354:24705/24708） | ✅ | 直写标记：目录内任意 Write/Edit（`aN` 无扩展名限制，与 `rUn` 一致，本轮修复）；戳记：仅 `.md`（`HD` 同款过滤），经变更队列串行 |
| `agent_settled` 提取 + 合并 | `$ln`（m0354:106749–106800） | ✅ | 门序/skip 消费游标/阈值不消费/trailing 旁路逐字（本轮对齐）；阈值计数器差异见 extract 表 |
| `memory_save` 名称归一化 | `ps()` + `ds`（m0169:1807/1752） | ✅ | 两步逻辑逐字（本轮修复） |
| `/memory`、`/pause-memory` | 命令注册（m0354:145226/145232）；面板 = pretty/m1646.js ≈895–1240 | ✅ | 注册表逐字（原版仅此两条 + 别名）；面板逐字对照：Auto-memory 开关、dream 开关 + last-ran 状态、"Open auto-memory folder" + "Open team memory folder"（本轮补齐）；org-store 行与 CLAUDE.md 列表为文档化省略；统计/手动提取为插件附加 |
| `/remember`、`/dream`、`/memory-extract` | 原版无此命令（dream 提示词引用 `/remember`） | 🛠 | 注册表对照确认；README 已如实映射 |
| `maybeNudgeDream` | `pEt = {minHours: 24, minSessions: 5}` + `hUn()`（m0354:107027–107045） | ✅ | 阈值与 tengu_onyx_plover 覆盖逻辑逐字 |
| `withFileMutationQueue`、单实例守卫、`setStatus`、debug 日志 | —（debug 对应 `n()` 日志习惯） | 🛠 | pi 基础设施 |

## 省略清单（⛔，README 省略表已声明原因）

`<memory_updates>` 过期刷新；`file_unchanged` 种子去重与 rewind 回滚（依赖 readFileState）；异步预取 + 2000ms 阻塞等待；命令别名（pi API 不支持）；auto-dream（改为 `/dream` 手动 + 提醒）；企业 Memory Stores；CLAUDE.md 层级加载；活动日志目录（dream 改读 pi 会话 JSONL）；页脚 "Recalled N memories" 聚合；遥测事件。

## 汇总

44 个导出：✅ 30、🛠 13、📄 0（`formatIndexLine` 按形状计 ✅，程序化生成器计 🛠 注记）。事件表 📄 清零：`/memory` 面板与 `maybeNudgeDream` 均已逐字核对（面板在 pretty/m1646.js，此前误判为不可得——全量源码在 claude-analysis/modules/，client-copy/ 有原始 exe）。

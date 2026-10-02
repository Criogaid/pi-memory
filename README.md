# pi-memory — Claude Code 式自动记忆插件（for pi coding agent）

将 Claude Code v2.1.252 的 **auto-memory（自动记忆）体系**移植为 [pi coding agent](https://github.com/badlogic/pi-mono) 扩展。设计依据见同工作区的逆向分析报告：`claude-analysis/report/`。

## 安装

> **只装一处**：全局（`~/.pi/agent/extensions/`）或项目（`.pi/extensions/`）二选一。两处同时装会在同一会话加载两份实例，导致提示词双重注入（pi 对同名命令会加 `:1/:2` 后缀共存，不会去重）。

```bash
# 方式一：复制到 pi 扩展目录（全局）
cp -r pi-memory-extension ~/.pi/agent/extensions/pi-memory

# 方式二：项目本地
cp -r pi-memory-extension <project>/.pi/extensions/pi-memory
```

pi 通过 jiti 直接加载 TypeScript，无需编译。会话内 `/reload` 即可热更新。

## 它做什么

| 功能 | 说明 | 对应 Claude Code 机制 |
|---|---|---|
| **记忆目录** | 个人记忆 `~/.pi/agent/memory/<项目slug>/`；可选项目共享层 `<project>/.pi/memory/`（配置 `sharedMemory: true`） | `~/.claude/agent-memory-local/<slug>/` 与团队目录 |
| **MEMORY.md 索引** | 会话启动时快照注入（保提示词缓存前缀，同原版每会话构建一次）；200 行 / 25KB 截断 + 三变体 `> WARNING:` 提示 | `Q5e()`/`oo()`/`mn()` |
| **记忆格式** | 单事实 .md 文件 + frontmatter 规范形状（`Y7n`：`ps` slug、`metadata.node_type: memory` 首键、戳记嵌套 metadata；旧版根层文件兼容读取），无戳写入整体规范化、已有戳原位刷新 `modified` | 四类型 + `stampNewMemoryContent`（`HD`/`Y7n`/`nQt`） |
| **Pinned** | 最多 4 条 `pinned: true` 记忆全文常驻上下文（`# Pinned memories` 段） | stone_shell 变体 |
| **`memory_save` 工具** | 一步写文件 + 更新索引；强制小写 kebab-case（允许下划线，同原版 `ds`）、4KB 上限、秘密扫描、pinned 上限、索引上限，失败自动回滚 | `memory_write`（企业版）+ 两步保存约定 |
| **Recall 注入** | 每轮按用户 prompt 关键词评分（词干还原 + 正文弱信号；单 token 非 CJK 查询跳过，同 `z4n`）选 ≤5 条记忆（同原版），以 `<system-reminder>` 注入，带 "N days old"（>1 天）时效免责声明、会话内去重、61KB 会话预算 | `relevant_memories` 附件 |
| **后台提取** | agent 结束后按门控（无直接写盘 / 有 ≥3 词用户发言 / 消息数阈值）触发一次结构化模型调用，输出 JSON 操作（upsert/delete），经插件校验后落盘 | `extractMemories` 受限子代理 |
| **Dream** | `/dream` 注入四阶段整理提示词（Orient → Gather → Consolidate → Prune & 对账 AGENTS.md），尾部附工具约束段与 "Sessions since last consolidation" 会话清单（按记忆目录 mtime 过滤 pi 会话），团队记忆的保守修剪纪律一并移植 | Dream 记忆整理 |
| **`#` 快捷键** | 首行仅 `# <内容>`（无后续正文）识别为显式记忆请求，经 input transform 转成 memory_save 指令 | `u$t()` 检测逻辑（含 `#!` 排除与多行正文排除） |
| **暂停持久化** | 暂停态写入会话条目，重载/恢复后保持（原版 session internal metadata 等价物） |
| **召回行上限** | 单记忆召回渲染 ≤200 行且 ≤4096 字节（原版 jEe/ZX 双上限，分原因标注） |
| **索引行精确解析** | 索引行按"分隔符锚定的链接目标"解析更新/删除，标题里含字面 `](x.md)` 的行不会被误删；重复 upsert 不累积空行 |
| **全角折叠** | 全角拉丁/数字折叠为半角后再分词（中文输入法场景 `Ｂｕｎ`≈`bun`） |
| **YAML 安全** | 写侧按需加引号（quoteLossyValues 语义，含冒号/引号/换行的描述不再是非法 YAML）；读侧 pi 严格解析器优先、宽松兜底 |
| **单实例守卫** | 全局+项目双装时第二实例自动惰性并告警（globalThis 哨兵，session_shutdown 释放，/reload 不受影响） |
| **原子写入** | 记忆文件/索引 tmp+rename 落盘（原版 staging rename） |
| **dream 提醒** | ≥5 会话且 ≥24h 未整理时页脚提示 /dream（原版 auto-dream 触发条件的提醒式实现） |
| **`/remember <file.md>`** | 把个人记忆提升为团队记忆（移动文件 + 重写索引指向 `team/`） | dream 提示词明确"提升是用户用 /remember 做的主动决策" |
| **管理命令** | `/memory` 面板（统计/暂停/手动提取/dream/auto-extract 开关/整体启用开关/打开个人与 team 记忆文件夹）、`/pause-memory` 会话级暂停（记忆目录读写全拦截，读/写各自原版文案）、`/memory-extract` | `/memory`、`/pause-memory` |

## 质量内核（从 Claude Code 逐字移植的提示词）

- **四种类型**：完整 `<types>` 块（含 when_to_save / how_to_use / 每类型示例；team 开启时带 `<scope>`，对应 mLe/Wyt 两变体）。
- **三准则**：applicable / durable / legible——"You must NOT save a memory unless you have validated that it is applicable, durable, AND legible."
- **负面清单**：代码结构、git 历史、修复配方、AGENTS.md 已有内容、临时任务状态——一律不存；用户明确要求时反问"哪里 non-obvious"。
- **写入纪律**：每条回复结束前自检是否学到 durable 教训，有则**同一回复内**写盘。
- **时效纪律**：记忆是快照；推荐其中提到的文件/函数/flag 前必须验证仍然存在。

## 配置

`~/.pi/agent/memory/config.json`（全局）或 `<project>/.pi/memory.json`（项目）；环境变量 `PI_MEMORY_DIR` 可覆盖 `memoryDir`（优先级最高，便于测试/容器场景）：

```json
{
  "memoryDir": "~/.pi/agent/memory",
  "sharedMemory": false,
  "autoExtract": true,
  "autoExtractMinMessages": 1,
  "recall": true,
  "citeMemories": false
}
```

- `citeMemories: true` 开启 `<cc-memory filenames="…">` 引用标注（Claude Code 的实验特性）。
环境变量 `PI_MEMORY_DEBUG=1` 输出调试日志（快照大小/召回命中/提取门控决策），对应原版的 n() debug 日志。

`autoExtractMinMessages` 默认 1 = 每个合格轮次（有用户散文且无直接写盘）都跑提取，与 Claude Code `tengu_bramble_lintel` 默认一致；嫌频率高可调大。召回上限为 5 个文件/轮（同原版）。
- `sharedMemory: true` 后，`memory_save` 与文件写入可用 `team/` 前缀访问项目共享记忆（可随仓库提交，替代 Claude Code 需要服务端的团队记忆）。

## 与 Claude Code 原版的取舍

| 原版机制 | 本插件处理 | 原因 |
|---|---|---|
| 提取子代理带工具循环（受限 canUseTool 沙箱） | 单次结构化模型调用 + 插件侧校验落盘 | pi 扩展无子代理 API；无模型驱动写盘面，安全边界更硬 |
| 记忆召回 = 索引引擎 或 LLM 选择器 | 关键词评分（词干 + 正文弱信号） | 无独立检索服务；规则可解释、零额外成本 |
| 企业 Memory Stores（服务端 + 版本令牌并发控制） | 省略；共享记忆走 git 提交的 `team/` 目录 | 依赖 Anthropic 服务端 |
| CLAUDE.md 层级加载 | 省略 | pi 原生加载 AGENTS.md 上下文文件 |
| 活动日志 `logs/YYYY/MM/DD/`（dream 的信号源） | dream 改为检索 pi 会话 JSONL | pi 会话格式不同 |
| `file_unchanged` seeded 去重、`<memory_updates>` 过期刷新 | 省略 | 依赖 Claude Code 内部 readFileState |

## 移植核对矩阵

[PORT-MATRIX.md](PORT-MATRIX.md)：每个导出函数 ↔ 原版函数的对照，逐格标注验证深度（已逐字核对 / 按报告核对 / 插件自创 / 省略）。

## 开发

```bash
# 类型检查（strict，零错误）
bun path/to/typescript/lib/tsc.js -p tsconfig.json

# 端到端验收：mock ExtensionAPI 模拟完整 pi 会话生命周期（38 项断言）
# （session_start → 提示词快照 → memory_save → # 快捷键 → 暂停拦截 →
#   提取门控/强制提取/游标持久化 → /remember → dream → 进度恢复）
bun test/e2e-acceptance.ts
```

本地开发需在插件目录建 node_modules 连接指向已安装的 pi 包（或直接 `npm i` 对应依赖）：

```bash
mkdir -p node_modules/@earendil-works
cmd /c mklink /J node_modules\@earendil-works\pi-coding-agent <pi包路径>
cmd /c mklink /J node_modules\@earendil-works\pi-ai <pi包路径>
cmd /c mklink /J node_modules\@earendil-works\pi-tui <pi包路径>
cmd /c mklink /J node_modules	ypebox <typebox包路径>
```

## pi API 复用清单

扩展刻意复用 pi 提供的原语而非重复造轮子：`before_agent_start`（提示词注入）、`input`（`#` 快捷键 transform）、`tool_call`/`tool_result`（暂停拦截与来源戳记）、`agent_settled`（提取触发）、`registerTool`/`registerCommand`/`registerEntryRenderer`、`appendEntry`（游标持久化）、`sessionManager.buildContextEntries()`（压缩感知的会话条目）、`convertToLlm`+`serializeConversation`（提取调用的转录序列化，与 pi 压缩摘要同源）、`withFileMutationQueue`（记忆文件与索引的并行写串行化）、`ctx.ui.setStatus/notify/select`、`ctx.modelRegistry.complete`、`SessionManager.list()`（dream 提醒）、`pi.exec`（打开记忆文件夹）、`pi.getActiveTools/setActiveTools`（禁用时移除 memory_save）、`parseFrontmatter`（严格 YAML 解析，失败回落宽松解析）。

# UGS 自我回顾与持续学习 Implementation Plan

> **For Hermes:** 使用可用的实施/委派技能逐项执行，并遵循 test-driven-development；实施前取得用户授权。禁止提交、推送、reset、stash、读取凭据或覆盖无关的未提交修改。本次仅调研与规划。

**Goal:** 在 UGS 已有记忆复盘与技能学习之上，交付“真实任务证据 → 受控回顾 → 候选/审批 → 可验证保存 → 下次实际复用 → 可撤销”的完整闭环，并以彩色文字清楚显示状态、依据和变化。

**Architecture:** 复用现有 TypeScript 技能运行时、completion-only HTTP 通道和 Rust/Node 技能事务服务；共用来源身份、预算、取消和审计基础设施，但保持记忆与技能的 schema、写入权限和生命周期分离。先修安全与持久化缺口，再补生产入口、候选治理、彩色展示和真实复用验收，不嵌入整个 Hermes。

**Tech Stack:** 现有 React 18 / TypeScript / Zustand / Tailwind、Tauri 2 / Rust、Node CLI / 远程服务；使用已有 Vitest、Rust/Node 测试和宿主事务能力。不新增向量数据库、模型训练服务或常驻 Python Agent。

---

## 1. 结论、范围与展示图例

**结论：修改现有系统比从零增加一套“反思器”更合理。** UGS 已有大量核心实现，缺口主要在后台记忆权限、审批归属、真实落盘、生产接线和效果证明。不能把“生成总结”“技能已加载”“工具结果说成功”当作完整学习闭环。

彩色版图例：**绿色＝已存在、可复用；蓝色＝本期补齐；紫色＝后续扩展；橙色＝待审批/政策选择；红色＝安全风险或发布阻断；灰色＝未知、跳过或不在范围。** 每种颜色同时显示文字标签，不仅靠颜色辨认。计划中的绿色表示代码存在，不自动表示已通过真实产品验收。

### 本期必须交付

- 自动回顾与手动复盘共用受控通道，但自动化不能获得前台工程执行权限。
- 用户事实、项目事实、可复用程序知识、原始会话记录分层；不自动双写。
- 精确来源消息持久化、独立预算、前台优先、取消、去重与后台任务恢复。
- 记忆审批保留原项目，整批 CAS、真实读回、失败保留提案。
- 普通任务的技能候选积累、第二次连续高度相似后送审、批准后实际保存。
- 桌面简单聊天、桌面 DAG、CLI、远程主入口的能力矩阵与生产级回归。
- 彩色状态/经验变化/证据/审批/diff/撤销界面，完整诊断在设置或回顾中心可查。
- 新任务 fresh-read 新版本，并由明确的宿主检查证明某条规则被采用。

### 明确不做

不训练模型参数；不自动修改产品源码、MCP/CLI 权限或凭据；不执行生成的脚本；不自动对外发布技能；不做首版向量检索、跨设备双向同步、跨根分布式事务或技能永久删除。长期历史研究、周报与独立代码审查可调用现有能力，不混入本次学习写入链。

### 调研基线

- 官方文档检索日期：2026-10-26。Hermes 源码固定 revision：`daec3cd4c6d34f5befbc8f25a8af3e3b84b94f06`，不是旧计划的历史 revision。
- UGS 本次 HEAD：`fc20a83a3660dbb7054e1593c4d99cb964537ffd`，分支 `main`；工作树有既有用户修改，实施前重新检查。
- 旧计划 `.hermes/plans/2026-10-09_184542-ugs-automatic-skill-learning.md` 保留作历史参考。本计划是当前代码的增量方案，不把旧计划中“拟新增模块”再次当作尚未实现。
- Hermes 官方全文、固定源码及详细证据包：`C:/Users/fengwei/AppData/Local/hermes/cache/scratch/hermes-review-research/research.md`。该 scratch 资料不是长期发布依赖；本计划正文与 Sources 已保留必要依据。

## 2. Hermes 功能调研：值得采用的机制与不能照抄的边界

### 2.1 四层知识，而非一个无限增长的总结文件

| 层 | Hermes 实际作用 | UGS 应支持 |
|---|---|---|
| Memory / USER | 小型持久事实，默认 MEMORY 2200 / USER 1375 字符；会话启动冻结注入 | 用户偏好与项目事实分开、容量限制、明确更新来源、下次会话生效 |
| Skills | 按任务类别组织的流程；索引发现 → 主文件全文 → 按需引用 | 优先修已有技能，记录一般规则与原因，不堆会话日志 |
| Session history | SQLite / FTS5 原始会话检索；不是把所有历史塞进记忆 | 留存来源消息，按需回查，摘要仍标派生信息 |
| Curator | 闲置状态维护与可恢复归档；LLM 合并默认关闭 | 先做治理建议和手动恢复，不让学习流程自动删库 |

来源：[H1][H2][H3][H4]。这属于外置知识学习，不是模型参数自我训练。

### 2.2 自动触发与显式复盘

- Hermes memory nudge 默认按 **10 个 conversation turns**；skill nudge 默认按 **10 个 agent-loop iterations**，在 turn 收尾检查。不是“每 10 条用户消息”或“10 次成功工具调用”。
- 自动 review 要求 final response、未中断、未跳过背景复盘，并有至少一个 nudge 命中；合并触发可同时回顾两种知识。
- `auxiliary.background_review.enabled` 默认启用；有子代理/worker 门控。本地 managed llama-server 可等空闲再运行。
- `/refine [focus]` 是显式学习复盘；Hermes `/review` 是独立审查机制，不能把两者当作同一个按钮。

来源：[H4][H5][H6]。UGS 已采用“真实完成工具活动”代理指标，应保留准确名称，不伪装成 Hermes iterations。

### 2.3 独立分叉、缓存与执行权限

Hermes 同模型分叉克隆历史、复用 cached system/tools 前缀；**工具 schema 保留不等于执行权限保留**。dispatch 默认只允许 skills、read_file/search_files；memory 还要对应触发和功能开关。skill-only review 不获得 built-in memory 写权限；terminal、通用 patch/write_file 默认不在白名单。配置可额外准入父代理已有工具，因此也不能宣传为无条件沙箱。[H4]

UGS 不需要复制 Python Agent 分叉：现有 completion-only HTTP 端口已经更适合本产品。摘要、预筛、打标和复盘必须全部走该低权限传输，任何失败都不得回退到 full CLI。

### 2.4 内容维护与写审批

- Hermes 默认 `memory.write_approval=false`、`skills.write_approval=false`，不是默认每次审批。技能审批开启时，前台和后台写都会 staging。
- **当前新增保护：无人值守 memory patch/remove，以及包含这些操作的 batch，即使通常审批关闭也要 staging；add 仍可直接进行。** attended `/refine` 与普通无人值守后台不同，但正常审批设置仍有效。[H7][H8]
- 改已有技能要在本次 review 完整读取确切目标；父历史引用不算。新技能/新支持文件不要求读取不存在的内容。[H9]
- Hermes 该读取 guard 本身主要记录 resolved path，不是 expected hash CAS。UGS 已有更严格的回执/hash/宿主事务，应该保留。
- Ownership/pin 主要约束删除、归档，**pin 不等于内容锁**；UGS 的外部只读、autoEditable、contentLocked 是更严格的应用政策，不能声称照搬 Hermes 默认。

### 2.5 预算、通知与可验证成果

Hermes review 配置 16 iterations；不等于全部 HTTP 请求硬上限。聚合 input budget 默认按模型 context 派生，并封顶；实际代码在下一 iteration 检查已用量，跨阈值的前一个请求可能已经完成。这是请求间止损，不能当作绝不超额的 admission 保证。[H4][H10]

成果摘要只读本次新产生的成功 memory/skill_manage 工具结果，排除继承的历史结果；staged 不说 completed。通知不写回主 transcript；通知关闭不等于学习关闭。[H4]

UGS 应更进一步：保存成功必须有宿主读回，保存与质量改善分开，unknown usage 不记零；不能仅显示“已学会”。

### 2.6 Curator 与文档冲突

固定源码默认：enabled=true、每 168 小时检查、至少闲置 2 小时、stale 14 天、archive 30 天、consolidate=false、prune_builtins=false、不自动永久删除。官方页面部分旧示意仍为 30/90 天，pin/telemetry 文字也有不一致处，本计划按固定可执行源码解释。[H3][H11]

UGS 当前建议 30/90 天和“仅建议”策略可以保留，这是产品政策，不必为追求 parity 改成 Hermes 默认。

## 3. UGS 当前能力与真实缺口

### 3.1 已有实现：优先复用，不重建

| 标记 | 已有能力 | 代码依据 | 仍需验证 |
|---|---|---|---|
| 已存在 | Memory 后台门控、两阶段摘要、库快照、合并重试 | `app/src/core/memoryReview.ts:37-47,87-119`；`app/src/store/useStore.ts:7112-7180` | 安全、取消、来源和持久化比技能链弱 |
| 已存在 | 原生工具证据、脱敏、排除 synthetic/unknown | `app/src/runtime/skills/evidence.ts:30-47,65-75` | 所有生产入口是否都转交 |
| 已存在 | scheduler、watermark、去重、前台优先 | `app/src/runtime/skills/trigger.ts:82-128,173-203`；`app/src/lib/skillLearningDesktop.ts:215-273` | 不以纯算法测试代替主入口验收 |
| 已存在 | 独立 HTTP reviewer、read/propose/noop、聚合预算 | `app/src/lib/modelGateway/skillReviewGateway.ts:15-58,118-158`；`app/src/runtime/skills/review.ts:65-97` | 记忆辅助阶段尚未全部迁移 |
| 已存在 | 连续两次、相似度 ≥0.95 的候选门槛 | `app/src/runtime/skills/preReview.ts:4,35-69` | 候选仓库并发、拒绝/回滚后重开 |
| 已存在 | Rust/Node 技能 fresh-read、CAS、事务、审批、撤销 | `app/src-tauri/src/skills/management.rs:347-418`；`app/src-tauri/src/skills/transactions.rs:211-330` | Rust create 数量宿主不变量 |
| 已存在 | 新任务全文加载、delivered 与 adoption 分离 | `app/src/runtime/skills/context.ts:92-118`；`app/src/lib/skillLearningDesktop.ts:346-358` | 没有通用生产 adoption emitter |
| 已存在 | 技能学习设置、diff/审批/撤销卡片、恢复 | `app/src/panels/settings/SkillLearningSettings.tsx:58-194`；`app/src/components/ai/SkillLearningCard.tsx:118-191` | 全状态诊断和彩色语义不完整 |

### 3.2 发布阻断：P0

| ID | 问题与影响 | 已核对代码 | 开发处理 |
|---|---|---|---|
| R01 | 记忆 review/digest/triage 可走通用 CLI；失败 fallback 可继承主聊天工程权限 | `memoryRefresh.ts:232-291`；`modelGateway/modelGateway.ts:25-59,85-119`；`useStore.ts:7156-7167`（均在 `app/src/`） | 迁移到 completion-only，fail closed；所有辅助调用禁止 CLI fallback |
| R02 | 记忆 pending 没有原项目；queue 明确丢弃 workspaceId，批准用当前页面项目 | `app/src/lib/memoryPending.ts:116-141,169-196` | pending v2 冻结来源，批准只能写原作用域 |
| R03 | 记忆批准先出队再写，忽略失败；浏览器写失败被吞；并发读改写可能丢数据 | `app/src/lib/memoryPending.ts:179-199`；`app/src/lib/memoryStore.ts:229-294,505-567` | 整批事务、CAS、readback、失败提案保留、准确结果 |
| R04 | desktop ready 主要证明会话存在，未确保精确来源用户消息 append 成功 | `app/src/store/useStore.ts:5380-5382,6586-6601`；`app/src/lib/skills.ts:108-118` | 来源消息持久化 Promise 与宿主核对必传；失败不授读写权限 |
| R05 | remote 主入口未传 sourceMessageId/ready/skills 回调，已有模块因此不启动学习 | `app/src/store/useStore.ts:6353-6369`；`app/src/store/remoteChatTurn.ts:748-754,958-970` | 修 producer payload，而非仅修子模块测试 |
| R06 | Rust manage 没有强制一批最多一个 create；模型 parser 限制不等于宿主限制 | `app/src-tauri/src/skills/management.rs:280-308` | 同步 Rust/Node/backend 不变量，批准路径也要生效 |

以上是已证实代码路径风险；本次未真实启动越权 CLI、未做实际用户数据写入或攻击利用测试。

### 3.3 补齐项：P1 / P2

- **P1 记忆生命周期**：累计消息数触发，无消费水位；调用前写冷却时间，失败静默；无独立 cancel/job，关闭写入开关不统一阻止后台写。同回合交互控件的真实回答未进入完整审阅证据。`useStore.ts:7039-7061,7118-7180`。
- **P1 预算/隐私**：摘要、审阅、合并、打标、预筛没有共用总预算；发送前未统一脱敏。不能用落盘扫描代替发送前保护。`memoryConsolidate.ts:103-136`；`memoryRefresh.ts:140-148`。
- **P1 候选一致性**：desktop/remote 候选在 localStorage，Node 在项目文件；load→模型比较→save 没 CAS，多进程可失更新。submitted 在待审批时置 true，未绑定 batchId/revision，拒绝/回滚缺重开策略。`skillCandidateStore.ts:5-15`；`runtime/skills/preReview.ts:34-76`。
- **P1 GUI DAG 接线**：算法支持 skillOrigin/context.skills，但生产 `buildGuiRunContext` 没填，结果未送学习器。`useStore.ts:10564-10599,10730-10764`。
- **P1 自动写政策不一致**：配置默认 auto-safe，但当前普通后台 desktop/CLI/remote 强制 approve-all。`skillLearningConfig.ts:5-17`；`skillLearningDesktop.ts:236`；`app/cli/io/skill-workflow.ts:109`。这是实际策略，不要用配置名承诺自动落盘。
- **P1 诊断不可见**：chat 隐藏失败/取消是现有测试明确要求；问题是 Settings 历史复用同一 gate 后也看不到这些状态。应增加诊断 surface，不能简单把所有后台噪音放回聊天。`components/ai/lib/skillReviewVisibility.ts:4-7`；`SkillLearningSettings.tsx:178-188`。
- **P1 复用效果**：有 adoption 验证接口，没有普通生产 emitter。generic tool success 和“已加载”都不能证明采用了某条技能。`skillLearningDesktop.ts:346-358,422-429`。
- **P2 快照/历史**：紧凑快照每轮重新读；完整快照缓存淘汰后旧会话可能变化；“最近 N 天”主要按会话更新时间，非逐消息时间。`useStore.ts:6417-6421`；`memoryStore.ts:713-745`；`memoryRefresh.ts:125-148`。
- **P2 治理**：lifecycle 有纯算法和建议设置，但未看到生产调度；手动 archive/restore 可复用。`runtime/skills/lifecycle.ts:19-33`。

## 4. 产品能力规格：自我回顾需要支持什么

| 编号 | 能力 | 必须行为 | 优先级 |
|---|---|---|---|
| F01 | 事实/流程分流 | user＝身份/跨任务偏好；memory＝来源项目事实；skills＝程序知识；历史不搬进小记忆库 | P0 |
| F02 | 完整来源 | host、server/account namespace、workspace、session、turn/source message、run、cwd 冻结 | P0 |
| F03 | 低权限复盘 | HTTP completion-only；无 terminal/CLI fallback；模型不提供权限/根路径 | P0 |
| F04 | 安全记忆审批 | 改写/删除自动阶段先送审；批准原批次、原作用域、精确 base revision | P0 |
| F05 | 可信保存 | 批次 applied/skipped/conflicted/failed 可区分；实际读回后才报保存 | P0 |
| F06 | 自动与手动 | 普通任务自动取证；手动 /refine focus 只跳触发门槛，不跳预算/权限 | P1 |
| F07 | 去重和强信号 | 真实用户纠正与失败→修复→验证；同任务 retry 不算第二次 | P1 |
| F08 | 候选政策 | 默认保留连续两次且 ≥0.95 送审；首次候选有可解释记录 | P1 |
| F09 | 预算和取消 | 总时间/输入/输出/调用数；前台优先；晚到模型不写，已 dispatch 事务如实收尾 | P1 |
| F10 | 生产入口覆盖 | 本地聊天、GUI DAG、CLI、remote 各有 producer 验收 | P1 |
| F11 | 彩色可解释展示 | 状态、经验类型、来源、变化、证据、成本、风险、动作；颜色配文字 | P1 |
| F12 | 历史/审批/撤销 | 主聊天安静，回顾中心全状态可查；跨重启保留，原目标 CAS 撤销 | P1 |
| F13 | 真正复用 | fresh-read、实际 outgoing payload、任务级 adoption checker、独立验证结果 | P1 |
| F14 | 容量与治理 | 记忆限额、候选保留、过期建议、pin/content lock 分开、包级归档恢复 | P2 |

隐私规则：构造快照之前脱敏；原始完整日志不默认上传外部 reviewer；只保留有界片段和可回查 ID；不读 .env 补上下文。高风险命中不是“批准即可绕过”，凭据与权限注入应硬拒绝。

## 5. 增量架构与数据契约

### 5.1 统一编排，不统一写权限

```text
真实来源消息持久化成功
  → 来源身份冻结 + 主任务事件采集
  → review scheduler（foreground priority / watermark / replay protection）
  → completion-only transport + 总预算 + 脱敏
  ├─ memory reviewer → MemoryProposal → MemoryHost transaction
  └─ skill reviewer → CandidateStore → SkillProposal → 现有 SkillHost transaction
  → host-confirmed outcome → 回顾历史 / 审批 / 彩色 UI
  → 新任务读取精确版本 → 任务级 adoption check → 效果记录
```

`runtime/` 保持不 import React/Zustand/Tauri/localStorage；宿主注入。复用技能调度/预算原则，但不要为了复用把所有 memory schema 改成 SKILL.md，也不要复制已工作的 Rust 技能事务。

### 5.2 拟新增契约（下列名称为设计目标，不是声称已有 API）

```ts
export type ReviewKind = 'memory' | 'skill';
export type ReviewPhase =
  | 'collecting' | 'eligible' | 'queued' | 'reading' | 'proposing'
  | 'awaiting_approval' | 'applying' | 'applied' | 'noop'
  | 'conflicted' | 'failed' | 'needs_recovery' | 'cancelled' | 'rejected';

export interface ReviewSource {
  hostId: string;
  namespaceId: string; // 宿主确认的服务器/账号命名空间，不含凭据
  workspaceId: string;
  sessionId: string;
  turnId: string;
  sourceMessageId: string;
  runId: string;
  cwd?: string;
}

export interface ReviewBudget {
  maxCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  timeoutMs: number;
}

export interface ReviewOutcome {
  reviewId: string;
  kind: ReviewKind;
  phase: ReviewPhase;
  source: ReviewSource;
  batchId?: string;
  appliedCount: number;
  skippedCount: number;
  beforeRevision?: string;
  afterRevision?: string;
  rollbackId?: string;
  errorCode?: string;
  usage: {
    calls: number;
    inputTokens?: number;
    outputTokens?: number;
    estimated: boolean;
  };
}
```

- `ReviewSource` 由生产 caller/宿主构造，模型输出拒绝 origin/namespace/root/approval/permission 字段。
- sourceMessageId 指真实 user message；交互回答另保留其原生 ID，不由助手总结代替。
- Memory pending v2 保留 **整个 batch**：source、target、operations、base revision、exact matched entry ID/hash、risk reasons、evidence IDs；不得拆成独立 op 先出队。
- 原 user/memory v2 条目兼容读取；新增稳定 entry ID 与 revision 在受控迁移中生成，坏 JSON/读取失败不可当成空库可写。
- 旧 pending 没有来源项目：user-only 可经内容校验提示迁移；project memory 一律进入 `needs_source_confirmation`，由用户指认来源后生成新提案，不能用当前项目猜测。
- CandidateStore 增加 revision/CAS 和 submission 状态：observed → eligible → staged(batchId) → applied(target revision) / rejected / conflicted / rolled_back。相同 source 唯一；重开是显式政策，不每轮自动重试被拒建议。
- skill 管理每 batch 最多一个 create 的约束在 Rust/Node/backend 宿主执行，且“一 create＋已有技能 additive patch”仍允许。

### 5.3 建议默认与迁移策略

| 配置 | 当前情况 | 本计划建议 |
|---|---|---|
| 记忆自动回顾 | 默认关闭，6 条累计消息 / 30 分钟 | 先保留关闭；启用后使用新增证据水位与明确门槛，不静默替用户打开 |
| 技能自动回顾 | enabled=true | 保留；HTTP 不可用显示 unavailable，不自动换成 CLI |
| 候选重复 | 连续两次、相似度 ≥0.95 | 保留默认；允许说明 A/B/A 会重置连续次数，未来改策略需显式选择 |
| 自动技能写入 | UI auto-safe，普通后台实际 approve-all | 本期明确展示“自动送审”；显式低风险 auto-apply 作为后续用户 opt-in，不直接移除后台 gate |
| Memory 改写/删除 | 现审批开关只管后台/刷新 | 无人值守 destructive batch 总是待审；若要求所有记忆写审批，前台也必须遵守 |
| 调用预算 | skill 6 次、输入 48000、输出 6000；timeout 600000ms | 先保留技能值，按总阶段计量；memory 建议最多6次/24000输入/4000输出/120000ms，全部可降低、硬上限受控 |
| 多种 review 并发 | 分散触发 | 同作用域一个在途，设备共享背景名额；前台优先，不递归学习自身 |
| 生命周期 | UGS 30/90 天，归档仅建议 | 保留30/90；首次观测不立刻归档；合并默认关闭 |
| 通知 | 普通 chat 隐藏进度/失败 | 保留安静 chat；回顾中心全状态，失败可追踪，必要时一个可关闭告警 |

预算是工程建议，不是已测成本最优值。即使 admission 估算严格，provider 的未知 token 或重试成本仍可能偏离；必须标 estimated/unknown，不能宣称绝不超过任何实际账单。

## 6. 彩色文字与界面完整方案

### 6.1 一套语义，不是给整段聊天任意上色

| 状态/文本角色 | 显示文字 | UGS token | 动作/规则 |
|---|---|---|---|
| queued / reading / proposing | 排队中 / 读取中 / 正在回顾 | `status-info` / `status-running` | 只表示真实状态，无虚构百分比；可取消未提交 review |
| 候选首次出现 | 已记录候选，等待再次验证 | `status-info` | 展示1次观察与触发条件，不说已保存技能 |
| awaiting_approval | 待批准 | `status-warning` | 来源、完整 diff、风险、批准/拒绝 |
| applying | 正在保存 | `status-running` | 禁重复点击，等待真实宿主结果 |
| applied | 经验已保存 | `status-success` | 只有 appliedCount>0 且确认目标才显示；可查看版本/撤销 |
| conflicted | 版本冲突，未覆盖 | `status-warning` | 重新读取生成新提案，不批准旧 diff |
| failed / needs_recovery | 回顾失败 / 需要恢复 | `status-error` | 显示原因与恢复/重试，不能隐藏在设置历史 |
| cancelled / rejected / noop | 已取消 / 已拒绝 / 无新经验 | `status-interrupted` / `fg-faint` | 静态、可查，不冒充执行仍在推进 |
| 只加载技能 | 已加载到本任务 | `status-info` | 不冒充采用或改善 |
| adoption 通过 | 此任务已验证采用 | `status-success` | 带 checker、精确 revision、证据链接 |
| 新增/删除 diff 行 | +新增 / −移除 | `status-success` / `status-error` | 可复制原文；不执行 HTML/脚本 |

使用现有 `app/tailwind.config.ts:37-52` 的语义 token；角色颜色随 UGS 主题变化，不硬编码 green/red utility。普通正文仍为 `fg/fg-dim`，避免整页彩虹影响阅读。紫色只用于本计划后续扩展标记，正式产品优先既有 status tokens。

### 6.2 三个展示位置

1. **聊天末尾紧凑卡片**：只展示确实产生的待审、保存、恢复需求；一句白话经验＋彩色状态＋来源＋“查看回顾”。默认 noop 和普通队列不刷聊天。
2. **设置 → 自我回顾/学习历史**：记忆/技能两个 tab，共用历史筛选；完整显示 running/failed/cancelled/noop，含模型、scope、原会话、预算、错误码、diff、批准/撤销。不能复用 chat-only visibility 隐藏所有诊断。
3. **会话侧栏或状态区小入口**：真实后台 busy 才显示细活动提示；等待输入/取消后停止动画。选中与忙碌独立，遵循 reduced-motion。

### 6.3 每条结果的阅读结构

“发生了什么” → “学到什么一般规则” → “为什么可信” → “会改哪里” → “是否已保存” → “下次如何触发” → “可做的动作”。

语言使用简体中文白话，不输出晦涩元术语；路径、命令、模型标识原样保留。示例仅作为设计样例：

> **待批准〔橙色〕**：导入的技能没有自动编辑授权。本次建议补上一条规则：修改文件前先检查项目编码和行尾。来源任务与目标版本可展开查看；还没有保存。

可访问性出口：状态有 icon/文字；role=status/alert 正确；键盘可聚焦；操作最小44px；暗/亮主题正文和重要状态目标4.5:1；320px窄宽不产生页面级横向溢出，代码/diff独立滚动；reduced-motion无持续动画。对比度应在实际主题测量，不以 token 名称代替验证。

## 7. 开发任务：18 个可执行增量包

**实施纪律：** 每包拆成单一行为的 RED→GREEN。每个步骤是独立动作：写一条最小回归 → 运行并确认预期失败 → 最小生产修复 → 重跑整个相关文件 → 查看差异/记录结果。不要先写所有想象测试再统一实现；未授权不提交。下面测试名称是建设目标，不是已通过声明。

### T01 · P0：统一低权限 HTTP 复盘传输

**Objective:** 记忆审阅、digest、consolidate、autotag、triage 都不再进入 coding CLI。

**Files:** 修改 `app/src/lib/memoryRefresh.ts`、`memoryConsolidate.ts`、`memoryAutotag.ts`、`memoryPending.ts`、`modelGateway/skillReviewGateway.ts`；拟新增 `app/src/lib/modelGateway/reviewCompletionGateway.ts` 和 `.test.ts`。不改变正常主聊天执行权限。

1. 在现有 gateway 测试加网络失败/无HTTP渠道/恶意tool_calls的单个 RED 回归，spy通用CLI启动为禁止。
2. 运行 `NODE_OPTIONS=--no-experimental-webstorage npm test -- src/lib/modelGateway/skillReviewGateway.test.ts src/lib/modelGateway/reviewCompletionGateway.test.ts`。
3. 提取现有 completion-only 传输小接口，显式 protocol/selection/signal/deadline/响应上限；所有记忆辅助阶段用同一接口。
4. 重跑 gateway、memory 辅助文件测试；证明失败只返回 unavailable/failed，不启动 full CLI。

**Done:** 所有后台与刷新辅助调用均无通用gateway fallback，模型/协议按reservation冻结。

### T02 · P0：来源消息持久化屏障

**Objective:** 会话存在不替代精确 user message 成功保存。

**Files:** 修改 `app/src/store/useStore.ts`、`app/src/lib/skills.ts`、`app/src-tauri/src/skills/host.rs`；扩展 `app/src/store/useStore.skill-learning.test.ts`、`app/src/lib/skills.test.ts`；拟新增 `app/src/store/useStore.review-source.test.ts`。

1. 注入session创建成功但source append失败的producer RED；断言没有list/view/model/manage授权。
2. 运行对应store与host测试，确认不是fixture漏mock造成的假失败。
3. 注册并转交同一source persistence Promise；await精确消息readback/身份检查再签发授权，禁止catch吞掉该屏障错误。
4. 验证立即首条消息、乐观UI/FIFO、导航切项目、晚到事件和取消不串源。

**Done:** persisted source ID与实际user内容一致，失败能观察且无背景权限。

### T03 · P0：记忆 pending v2 保留整批和原作用域

**Objective:** A项目提案在B页面批准仍只能写A，且旧项目提案不能猜源。

**Files:** 修改 `app/src/lib/memoryPending.ts`、`app/src/panels/settings/MemorySettings.tsx`；扩展现有 `.test.ts/.test.tsx`；拟新增 `app/src/lib/memoryPending.migration.test.ts`。

1. 添加跨项目批准、全局user作用域、缺来源legacy三条行为，逐条RED→GREEN。
2. 运行 `npm test -- src/lib/memoryPending.test.ts src/lib/memoryPending.migration.test.ts`，加既定NODE_OPTIONS。
3. v2保存source/batch/base revision/evidence；队列只收合法完整batch，按原来源批准。
4. 旧project pending隔离待用户确认；旧user-only迁移也不得悄悄写入；去重包含scope。

**Done:** 审批页面展示原项目和会话，当前UI项目从不决定写入目标。

### T04 · P0：记忆宿主事务、CAS与真实结果

**Objective:** 写失败、超限、冲突不能显示成功或丢弃提案。

**Files:** 修改 `app/src/lib/memoryStore.ts`、`memoryPending.ts`、`memoryConsolidate.ts`、`memoryRefresh.ts`、`app/src-tauri/src/history.rs`；拟新增 `app/src-tauri/src/memory_transactions.rs`（接入现有Tauri注册位置）、`app/src/lib/memoryStore.durability.test.ts`。

1. 先写localStorage quota失败、并发add丢写、批准超限仍保留pending的独立RED。
2. 实现TS串行/CAS边界与错误传播；Tauri跨进程锁/intent/备份/原子替换/读回，沿用技能服务的安全模式但不复用其权限。
3. 用真实临时文件测试崩溃/文件占用/坏JSON/第二操作失败；unknown读不允许覆盖成空库。
4. readback成功后更新appliedCount并出队；skipped重复不计applied；失败保留diff和原batch。

**Done:** 同库批次可恢复原子性；user+project跨库提案显式拆成两批，不宣称跨库事务。撤销是新CAS事务，不覆盖之后的手改。

### T05 · P0：Rust 宿主 create 数量不变量

**Objective:** 模型或直连host都不能一批新建多个技能。

**Files:** 修改 `app/src-tauri/src/skills/management.rs`；扩展 `app/src-tauri/src/skills/transactions_tests.rs` 或现有service测试；对照 `backend/src/workspace-skill-service.mjs` 和 `backend/test/workspace-skill-service.test.mjs`。

1. 写direct-host两个不同create必须拒绝且文件完全不变的Rust RED。
2. 在batch staging前统计create并硬拒绝>1，包括approve-all。
3. 加“一create＋现有技能additive patch”成功回归，避免限制过严。
4. 运行 `cargo test --manifest-path src-tauri/Cargo.toml --lib skills::`，与Node/backend行为比较。

**Done:** parser和所有宿主同一约束，审批无法绕过。

### T06 · P0：严格协议与完整预筛判决

**Objective:** 无效操作/遗漏ID不能悄悄执行合法子集或删除未判定项。

**Files:** 修改 `app/src/core/memoryProtocol.ts`、`app/src/lib/memoryPending.ts`；扩展 `memoryProtocol.test.ts`、`memoryPending.test.ts`。

1. 写add＋非法action全拒、未知字段拒绝、keep/drop遗漏/重复/交叉/未知ID的RED。
2. 实现全payload校验后才应用；verdict覆盖exact合法ID集合。
3. 失败只保留原队列，不删除；一次确定性修正仍受T01总预算。
4. 重跑整个协议/预筛文件，补恶意文字作为数据不授权限测试。

**Done:** 不完整判决fail closed，没有部分副作用。

### T07 · P1：记忆回顾 job、水位与取消

**Objective:** 取代旧fire-and-forget，保证可控、可诊断且不重复计费。

**Files:** 修改 `app/src/core/memoryReview.ts`、`app/src/lib/memoryConfig.ts`、`app/src/store/useStore.ts`、`memoryConsolidate.ts`；拟新增 `app/src/runtime/memory/review.ts`、`review.test.ts`、`app/src/lib/memoryReviewDesktop.ts`；复用 `runtime/skills/trigger.ts` 原则。

1. 写终态前不得审阅、失败不消费水位、关闭/新前台取消、同交互回答入源的RED。
2. 引入freeze job/observe→reserve→finish；按新证据范围消费，回顾自身不递归取证。
3. 统一digest/review/retry/autotag/triage总预算和发送前脱敏；头部摘要输入与输出有界。
4. 虚拟时钟和晚到completion验证；已dispatch事务返回真实结果，不改写成假cancelled。

**Done:** 关闭写入禁止新后台写，读取/回顾开关语义明确；独立job有取消与可恢复记录。

### T08 · P1：remote 主入口真正接线

**Objective:** 真实远程聊天能自动候选/送审/读回，不靠子模块测试手填字段。

**Files:** 修改 `app/src/store/useStore.ts`、`remoteChatTurn.ts`、`app/src/lib/remoteSkillLearning.ts`；扩展 `remoteChatTurn.skills.test.ts`；拟新增 `app/src/store/useStore.remote-learning.test.ts`；必要时扩展 `packages/protocol/index.ts` 与backend对应测试。

1. 从唯一生产caller写RED，断言sourceMessageId/ready/explicitSkillIds/context/state回调全部传到真实模块。
2. 由冻结remote workspace+server/account命名空间构造源；保持鉴权与source barrier。
3. remote host写/读都在服务端，客户端只显示结果；上下文实际进入outgoing request。
4. 测断连、导航、重连恢复、晚到终态、同名本地路径完全不变。

**Done:** 普通remote任务满足条件后有真实后台输出，不能仅证明helper存在。

### T09 · P1：GUI DAG 自动学习和完整上下文

**Objective:** 图工作流也能取证、复用和回顾，仍只在整个run终态调度。

**Files:** 修改 `app/src/store/useStore.ts` 的 `buildGuiRunContext` / run终态、`app/src/runtime/dag.ts`、`gateway.ts`、`types.ts`；拟新增 `app/src/store/useStore.dag-learning.test.ts`；扩展 `app/src/runtime/skills/dag-evidence.test.ts`。

1. 写GUI producer遗漏skillOrigin/context/finish的RED。
2. 把冻结来源与skill context注入run，节点工具事件在UI裁剪前收集。
3. completed run才eligible；多节点并发dedupe；中断/失败仅保留真实证据不伪造成功。
4. 验证模型实际payload和run结果，其他会话/节点不改变归属。

**Done:** GUI DAG支持明确列入能力矩阵，有生产级测试而非类型声明。

### T10 · P1：候选持久化、CAS和submission生命周期

**Objective:** 多实例不丢候选，拒绝/回滚/技能改版后状态可解释。

**Files:** 修改 `app/src/runtime/skills/preReview.ts`、`review.ts`、`app/src/lib/skillCandidateStore.ts`、`app/cli/io/skill-candidate-store.ts`、remote adapter；扩展各现有测试；拟新增 `backend/test/skill-candidates.concurrent.test.mjs` 与宿主候选服务。

1. 并发A/B观察丢失、同source retry、staged后拒绝、已应用目标新revision分别RED。
2. 在宿主事务/CAS中更新candidate；模型比较在锁外，commit检查base revision，冲突有界重算。
3. 服务器候选包含tenant/server/account/workspace身份；本地同宿主桌面/CLI可共用权威仓库，UI缓存不是主副本。
4. submitted改为关联batchId/targetRevision的状态；拒绝默认抑制重复建议，用户显式重开；回滚不自动再应用。

**Done:** 保留连续两次0.95政策；不会用清库/强制改测试源来绕过replay fence。

### T11 · P1：政策UI与实际后台行为一致

**Objective:** 用户知道当前是自动送审还是自动落盘。

**Files:** 修改 `app/src/lib/skillLearningConfig.ts`、`runtime/skills/types.ts`、`skillLearningDesktop.ts`、`remoteSkillLearning.ts`、`app/cli/io/skill-workflow.ts`、`SkillLearningSettings.tsx` 及配置/UI测试。

1. 写default auto-safe但后台approve-all必须如实展示的RED。
2. 拆分background write policy与显式命令policy，迁移保留现实际approve-all。
3. 设置解释两次门槛、选定reviewer、安全不可用原因、全部预算；不存凭据。
4. 验证off/close不删历史且取消未提交job；显式/refine不跳安全和权限。

**Done:** 不在本期偷偷启用后台auto-apply；后续opt-in必须宿主授权及风险矩阵通过。

### T12 · P1：全状态回顾历史与恢复入口

**Objective:** chat保持安静，但进度/失败/取消在诊断中心可见。

**Files:** 修改 `app/src/components/ai/lib/skillReviewVisibility.ts`、`SkillLearningCard.tsx`、`SkillLearningSettings.tsx`、`MemorySettings.tsx`、`app/src/components/SkillLearningRecovery.tsx`；拟新增 `app/src/components/ai/ReviewHistoryList.tsx` 和 `.test.tsx`。

1. 写failed在history可见、chat仍隐藏的RED；原chat安静测试保留。
2. 加明确surface参数/独立history renderer，不把所有背景进度刷回chat。
3. 保存source/error/usage/queuedAt/updatedAt；重启保留取消与恢复，不把无resume旧记录冒充可重跑。
4. 测原batch动作、重复点击、来源不匹配、失败重试和事务恢复。

**Done:** 任意review有解释；失败不能因为没有changes而从诊断消失。

### T13 · P1：彩色文字、差异和可访问性

**Objective:** 用现有主题token表达真实语义，区别保存、加载、采用。

**Files:** 修改 `SkillLearningCard.tsx`、新 `ReviewHistoryList.tsx`、`app/src/styles/global.css`（仅必要token seam）；拟新增 `app/src/components/ai/lib/reviewPresentation.ts` 和 `.test.ts`；使用现有Tailwind token。

1. 写phase→label/token/actions映射RED；applied但无宿主结果不能绿色成功。
2. 按第6节实现状态、风险、diff +/-、事实/技能类型；“已学会”改为可证实的“经验已保存”。
3. 浏览器/真实Tauri组件测试暗亮主题、320px/常规宽、超长路径/diff、键盘和reduced-motion。
4. 测实际computed styles/contrast和几何；HTML内容仅作为文本，不允许执行。

**Done:** 彩色不是仅emoji或硬编码；颜色与标签配对，复制文本保持原命令/路径。

### T14 · P1：更新真实provider闭环验收

**Objective:** 验收脚本遵守当前两次候选门槛和审批政策。

**Files:** 修改 `app/src/lib/skillLearningLive.integration.test.ts`；拟新增 `app/src/lib/review.live-acceptance.test.ts`、`app/doc/ugs-self-review-acceptance.md`。

1. 旧live测试首次直接applied不再作为当前自动策略标准；改成普通任务1候选、任务2送审、批准、任务3复用。
2. 先用deterministic HTTP+真实文件确认全链；独立真实provider case需要环境配置且不打印secret。
3. 分desktop installed Tauri / Node CLI / remote记录reviewId/batchId/版本/产物，不注入host成功响应充数。
4. 取消/冲突/回滚单独执行并fresh-read。

**Done:** skipped明确报告，未执行不当作pass；helper成功不能关闭父产品验收。

### T15 · P2：任务级技能 adoption checker

**Objective:** “已验证采用”有明确宿主证据，不从泛化成功猜测。

**Files:** 修改 `app/src/lib/skillLearningDesktop.ts`、`app/cli/io/skill-workflow.ts`；拟新增 `app/src/runtime/skills/adoption.ts` 和 `.test.ts`；必要的Rust/remote宿主check入口与测试。

1. 写generic shell exit0/模型自述不能增加usedWithEvidence的RED。
2. 首批只支持确定性规则，例如派生产物位于指定工作区目录；宿主检查真实产物路径并关联已delivered的确切skillId/revision/source turn。
3. 生产emitter转交现有onHostEvidence/recordVerifiedUsage；其他任务只显示delivered，未知采用不强推。
4. 验证同revision replay去重、新revision独立、跨turn证据拒绝、abort及时撤授权。

**Done:** 只对支持的check宣称采用，不包装成所有引擎/任务通用效果评分。

### T16 · P2：快照冻结与历史时间范围

**Objective:** compact/full遵循同一会话快照，旧会话不因缓存淘汰换值。

**Files:** 修改 `app/src/lib/memoryStore.ts`、`memoryRefresh.ts`、`app/src/store/useStore.ts`；扩展相应tests；拟新增 `app/src/lib/memorySnapshot.lifecycle.test.ts`。

1. compact同session多轮、超过32活跃key、重启恢复、最近N天逐消息筛选分别RED。
2. session-owned版本快照，生命周期显式释放；compact由同快照派生，不每轮重新读live。
3. 手动明确刷新可创建新snapshot version，避免无声改变历史前缀。
4. 验证新session读最新版本、旧session不变、payload system/history前缀稳定。

**Done:** 不宣称每轮缓存命中必然提升；只验证实际不改旧上下文。

### T17 · P2：生命周期生产调度与可恢复治理

**Objective:** 当前advisory算法有生产入口，但默认不自动移动/删除技能。

**Files:** 修改 `app/src/runtime/skills/lifecycle.ts`、`SkillLearningSettings.tsx`；拟新增 `app/src/lib/skillLifecycleDesktop.ts` 和测试；复用现有host archive/restore。

1. 首次观察不归档、pin/cron/external保护、view≠adoption分别回归。
2. 空闲低频deterministic评估、保存firstObservedAt/stale建议；不调用模型，不在每轮执行全库扫描。
3. 手动包级archive/restore带来源和版本；未来自动归档单独opt-in，LLM合并只提案且默认关闭。
4. 测支持文件/引用/来源完整恢复、并发手改不丢、无永久删除。

**Done:** UI“仅建议”与实际行为一致；未使用不等于无价值。

### T18 · 发布门禁：故障矩阵、能力表与灰度

**Objective:** 每个公开支持入口都有实际验收证据，回滚开关可用。

**Files:** 新增 `app/doc/ugs-self-review-acceptance.md`、`app/doc/ugs-self-review-capabilities.md`；更新项目既有用户文档；必要producer/integration测试。

1. 按第9节执行全部发布必选场景，保存参数/真实输出/产物句柄，逐项核对。
2. run typecheck/prompt-lock/CLI build/app build及Rust/Node专项，比较实施前dirty工作树基线。
3. 内部测试先禁自动写、只送审；小范围开启background review，监控failed/noop/staged/applied、budget、冲突与重复，不编造改善百分比。
4. 演练关闭review、恢复pending/事务、撤销学习、不影响主聊天；能力表明确supported/limited/unavailable。

**Done:** 不因测试准备好就宣称发布；真实provider/installed surface未跑的格子不得标完成。

## 8. 排期、依赖与交付物

以下是熟悉现有代码的工程师的**粗估工作量，不是工期承诺**；测试环境、provider和Windows故障注入可能增加时间。任务的每个小行为按垂直TDD实施，安全review与QA穿插进行。

| 里程碑 | 任务 | 粗估人日 | 交付出口 |
|---|---|---|---|
| M0 · 安全与落盘 | T01–T06 | 5–7 | 禁后台CLI；来源、审批、事务和host invariant通过 |
| M1 · 生产链路 | T07–T09 | 4–6 | memory job、remote、GUI DAG实际接线 |
| M2 · 候选与彩色UI | T10–T13 | 4–6 | 候选CAS、政策一致、全状态诊断和彩色可用 |
| M3 · 复用与治理 | T14–T17 | 4–6 | 当前政策live闭环、限定adoption、冻结与治理 |
| M4 · 发布 | T18 | 2–3 | 能力矩阵、故障验收、灰度/关闭/恢复完成 |

**合计粗估：19–28 人日。** 可并行前端呈现与独立Rust限制，但不能绕过依赖：T01/T02是所有新后台链路前提；T03→T04；T07依赖安全传输和存储；T08/T09依赖source barrier；T10/T11完成后跑T14；T15不阻止“保存/加载”发布，但未完成时不能显示“已验证采用”。

首个可交付增量应是 **修复P0＋安全自动送审＋完整诊断**，不是另建反思聊天机器人。后续再把桌面DAG/remote、效果验证和治理全部关闭验收。

## 9. 验收矩阵：不能只验证“已有模块”

| ID | 场景 | 必须观察的结果 | 发布范围 |
|---|---|---|---|
| A01 | review/digest/triage的HTTP失败或不可用 | 明确failed/unavailable；无任何CLI启动 | 必选 |
| A02 | session存在但source message append失败 | 没有读/写授权与模型调用 | 必选 |
| A03 | A项目提案在B页面批准 | 写A或因A不可用拒绝；B不变 | 必选 |
| A04 | legacy project pending无来源 | 隔离等待指认，不猜当前项目 | 必选 |
| A05 | 批准超限/磁盘或storage失败 | pending保留；appliedCount=0；错误可查 | 必选 |
| A06 | 同库并发两个add | 两条都保留或一方明确冲突，无lost update | 必选 |
| A07 | batch第二操作失败/进程崩溃 | 原内容恢复或needs_recovery；无半成功卡 | 必选 |
| A08 | Rust direct-host两个create | staging前拒绝；零文件变化 | 必选 |
| A09 | 一个create＋既有技能安全补丁 | 合法整批可送审/提交，不被过严规则拒绝 | 必选 |
| A10 | memory协议含一个非法操作 | 整个payload拒绝，无合法子集副作用 | 必选 |
| A11 | triage判决缺ID/交叉/重复 | 原队列完全不变 | 必选 |
| A12 | 新前台/关闭review/用户Stop | 未提交review取消；晚到completion不写 | 必选 |
| A13 | host.manage已dispatch后取消 | 真实applied/recovery可见，不谎报纯cancelled | 必选 |
| A14 | ordinary task首次经验/第二次≥0.95 | 首次candidate；第二次awaiting_approval；无手动命令代替 | 必选 |
| A15 | retry同task、A/B/A、相似度0.94 | 不冒充第二次连续高度相似 | 必选 |
| A16 | candidate并发/拒绝/回滚/目标更新 | CAS正确；状态与batch/revision关联、重开政策明确 | 必选 |
| A17 | remote真实主入口 | source与callbacks确实传入；远程写/读，本地同名路径不变 | remote支持必选 |
| A18 | GUI DAG真实run | context进入payload，证据进入finish，终态才回顾 | GUI DAG支持必选 |
| A19 | memory与skills同时合格 | 共用背景预算/优先权；不自动双写同条流程 | 必选 |
| A20 | 超长日志、secret-like文本、未知usage | 发送前脱敏/有界；未知输出不记0；总预算包括辅助阶段 | 必选 |
| A21 | chat安静＋history failed/cancelled | chat不刷噪音；诊断可见并能重试/查看错误 | 必选 |
| A22 | applied/staged/conflict彩色与长diff | 标签/颜色/动作正确；不会执行提案HTML | 必选 |
| A23 | 暗亮主题、320px、键盘、reduced-motion | 对比度/几何/焦点检查通过；无持续多重动画 | 必选 |
| A24 | 批准后新任务全文读取 | 实际payload含新规则与新revision；旧history前缀不变 | 必选 |
| A25 | 任务级adoption / generic工具成功 | 只有精确宿主check才计采用；不支持时仅delivered | 声称采用时必选 |
| A26 | rollback重启＋lifecycle建议 | fresh-read旧版本；包完整；首次观察/保护对象不自动归档 | 必选 |

每条验收分层记录：L1纯算法、L2真实producer/mocked边界、L3真实HTTP+filesystem宿主、L4真实provider+安装版入口。不能用L1/L2通过关闭L4承诺。远程/DAG若未通过能力出口，只能标limited，不能标已支持。

## 10. 验证命令、当前结果与发布边界

### 当前真正执行的基线

父代理实际执行两批，均 exit 0：

- 7个测试文件：`memoryReview`、`trigger`、`preReview`、`review`、`SkillLearningCard`、`SkillLearningSettings`、`useStore.skill-learning`：**146 passed，1 skipped**。
- 6个测试文件：`skillReviewGateway`、`modelGateway`、`memoryPending`、`memoryStore`、`memoryProtocol`、`memoryConsolidate`：**118 passed**。
- 这些是既有测试通过；上述风险说明测试还缺对应生产/故障断言，不能推出风险不存在。没有运行全量构建、Rust全量或本次新功能live验收。
- 子代理另做只读静态调用追踪与模拟内存IO行为探针；并发丢写/错项目批准等探针不是实际用户文件写入，也不是实际Tauri/provider验收。

### 实施时局部和整体门禁

```bash
# workdir: E:/UltraGameStudio/app
NODE_OPTIONS=--no-experimental-webstorage npm test -- src/core/memoryReview.test.ts src/core/memoryProtocol.test.ts src/lib/memoryConfig.test.ts src/lib/memorySafety.test.ts src/lib/memoryStore.test.ts src/lib/memoryPending.test.ts src/lib/memoryConsolidate.test.ts src/lib/memoryAutotag.test.ts src/panels/settings/MemorySettings.test.tsx
NODE_OPTIONS=--no-experimental-webstorage npm test -- src/runtime/skills src/lib/modelGateway/skillReviewGateway.test.ts src/lib/skillLearningDesktop.test.ts src/components/ai/SkillLearningCard.test.tsx src/panels/settings/SkillLearningSettings.test.tsx src/store/useStore.skill-learning.test.ts src/store/remoteChatTurn.skills.test.ts
NODE_OPTIONS=--no-experimental-webstorage npm test -- cli/io/skill-workflow.test.ts cli/config/providers.test.ts cli/runtime-host.skill.test.ts cli/commands/studio.test.ts
cargo test --manifest-path src-tauri/Cargo.toml --lib skills::
npm run typecheck
npm run check:prompt-lock
npm run cli:build
npm run build
NODE_OPTIONS=--no-experimental-webstorage npm test

# workdir: E:/UltraGameStudio
node --test backend/test/workspace-skill-service.test.mjs backend/test/workspace-skills.test.mjs backend/test/runner.test.mjs
```

新增测试须先创建，再按各T包运行，不把不存在的文件当已验证命令。现场再次核对脚本/工具链。全量已有红时按exact suite/test/error和实施前dirty工作树比较；“无新增失败”不能改写为“全量通过”。真实provider只通过已有安全配置读取，禁止在聊天、测试输出或计划中粘贴secret。

## 11. 风险、取舍与发布前决策

- **学习污染**：一次成功可能只是巧合。保留两次门槛、优先修补、真实来源、正常noop与审批；不追求技能新增数量。
- **错误合并**：0.95是模型判断，不是客观校准概率；相同工具/主题不等于同规则。保留触发条件、原因、动作与反向规则区分，不自动合并整个技能库。
- **安全与体验**：自动送审已经是自动学习链的一部分，不为了“更像Hermes”开放full CLI或无人值守删除。后续auto-apply需用户opt-in与独立发布gate。
- **作用域**：user偏好跨项目与项目事实冲突应提示裁决；不能模型自动把项目经验推广全局。多账号/服务器候选身份要比原host/workspace更加完整。
- **存储承诺**：只承诺宿主服务消费者的可恢复批次一致性，不声称Windows文件系统提供外部raw reader跨文件瞬时原子性。
- **成本**：所有辅助阶段计入；provider不返回usage时保守估计。未实测改善/成本下降，不展示虚构百分比。
- **依赖与用户工作树**：现lib.rs/Cargo.toml等有用户修改，只编辑必要区域；不升级无关工具链、不reset。测试fixture不得弱化真实持久化屏障。
- **UI噪音**：保留安静chat惯例；显式诊断入口解决可观察性，不用持续红色弹窗轰炸。

发布前需明确但不阻止先修P0：是否开放background auto-apply opt-in；是否将CLI/remote记忆回顾纳入首个发布；候选被拒后用户手动重开的入口；哪些任务有正式adoption checker。默认按本计划的保守策略执行，不静默更改既有用户选择。

## 12. 本次交付与下一步

本次只新增这份调研开发计划及scratch中的彩色阅读版，未实现任何UGS业务改动，未提交/推送。完成了官方文档与固定源码核对、当前生产路径审计和两批相关测试基线。

开发顺序：**T01–T06先修权限/归属/真实落盘 → T07–T09补主入口 → T10–T13候选与彩色诊断 → T14–T17复用/冻结/治理 → T18发布验收。** “完整计划”不表示这些开发项已经完成。

## Sources

- [H1] Persistent Memory：https://hermes-agent.nousresearch.com/docs/user-guide/features/memory
- [H2] Skills System：https://hermes-agent.nousresearch.com/docs/user-guide/features/skills
- [H3] Curator：https://hermes-agent.nousresearch.com/docs/user-guide/features/curator
- [H4] 固定背景复盘源码：https://raw.githubusercontent.com/NousResearch/hermes-agent/daec3cd4c6d34f5befbc8f25a8af3e3b84b94f06/agent/background_review.py
- [H5] iteration计数：https://raw.githubusercontent.com/NousResearch/hermes-agent/daec3cd4c6d34f5befbc8f25a8af3e3b84b94f06/agent/turn_iteration_prep.py
- [H6] turn终态门控：https://raw.githubusercontent.com/NousResearch/hermes-agent/daec3cd4c6d34f5befbc8f25a8af3e3b84b94f06/agent/turn_finalizer.py
- [H7] unattended记忆保护：https://raw.githubusercontent.com/NousResearch/hermes-agent/daec3cd4c6d34f5befbc8f25a8af3e3b84b94f06/tools/memory_tool.py
- [H8] 写审批：https://raw.githubusercontent.com/NousResearch/hermes-agent/daec3cd4c6d34f5befbc8f25a8af3e3b84b94f06/tools/write_approval.py
- [H9] 技能读/写guards：https://raw.githubusercontent.com/NousResearch/hermes-agent/daec3cd4c6d34f5befbc8f25a8af3e3b84b94f06/tools/skill_manager_guards.py
- [H10] 请求间预算检查：https://raw.githubusercontent.com/NousResearch/hermes-agent/daec3cd4c6d34f5befbc8f25a8af3e3b84b94f06/agent/conversation_loop.py
- [H11] 当前默认配置：https://raw.githubusercontent.com/NousResearch/hermes-agent/daec3cd4c6d34f5befbc8f25a8af3e3b84b94f06/hermes_cli/config_defaults.py
- [H12] 技能批次恢复：https://raw.githubusercontent.com/NousResearch/hermes-agent/daec3cd4c6d34f5befbc8f25a8af3e3b84b94f06/tools/skill_manager_batch.py
- [H13] 独立审查而非refine：https://raw.githubusercontent.com/NousResearch/hermes-agent/daec3cd4c6d34f5befbc8f25a8af3e3b84b94f06/agent/review_engine.py
- [H14] 官方完整索引：https://hermes-agent.nousresearch.com/docs/llms.txt

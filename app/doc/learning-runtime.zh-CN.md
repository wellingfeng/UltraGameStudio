# 记忆复盘与技能自动学习：能力与验收边界

本文说明现有学习运行时的行为、权限和验收方式。它不是发布通过证书，也不代表模型参数训练。完整开发与验收范围见 [开发计划](../../.hermes/plans/2026-10-26_211126-ugs-self-review-complete-plan.md)。

## 学习的两条链

- **记忆**保存用户／项目事实。复盘输出经严格协议解析、整批审批或安全写入判定，再由宿主按原始版本执行事务。
- **技能**保存可复用操作规则。独立 reviewer 只返回 read／propose／noop；候选需在不同任务中连续出现至少两次，且相似度不低于 0.95，才进入提交阶段。宿主决定实际批准、写入和回滚。

二者共享可信来源、前台优先原则和受限复盘传输，但不共用业务 schema，不自动双写。技能不是一次性任务日志，工具成功也不必然意味着值得生成技能。合法的 noop 是正常结果。

### 什么不是学习成功

以下信息均不能单独证明已经保存或在下一任务中遵循：

- 模型说“已保存”，工具 Promise resolved，队列项消失。
- UI 乐观缓存发生变化，组件显示绿色，源码中存在 IPC 命令名。
- 技能完整内容被送达，或者任意一次工具执行成功。
- 只有 fixture、自报执行结果或模型总结的“验证”。

保存必须以宿主事务与真实读回为依据。送达与遵循分别统计；遵循需绑定实际送达的技能 revision、原任务和专门的宿主检查。

## 来源与权限

### 桌面原生来源

本地复盘保存之前，须等待确切用户消息持久化，并通过不使用乐观缓存的 native history 重新读取来源。来源包含 host／workspace／session／turn／run；只保存会话空壳不够。原文、多模态内容及原 workspace 必须匹配。

原生技能宿主独立核对磁盘来源与工作区绑定。候选 namespace 在宿主内部派生，客户端不能指定任意目录。记忆读写 IPC 也检查调用方 app 身份。

### Node／远程

Node 使用工作区宿主、受控来源和真实文件事务。远程候选客户端通过普通鉴权访问生产路由；服务端校验 workspace 所有权，并从服务器身份／租户／用户／工作区派生存储 namespace，不回退到本地存储。

**远程传输存在不等于远程产品入口已开放。** Cloud 退休开关仍保持关闭；不能为了展示能力而在生产启用退休分支。缺可信远程 namespace 时，持久化空闲建议不可用；当前桌面面板没有远程恢复控制器时，也不显示可执行的远程重试。

纯浏览器 fixture 无法提供 Tauri 权限或原生磁盘持久化证明。

## 独立复盘模型

复盘、摘要、协议纠正、预筛／相似性判断和自动标签只使用 completion-only HTTP。不会因为 HTTP 失败、缺独立 reviewer 或 coding CLI 不支持安全胶囊而回退到前台编码代理。

- 支持 Anthropic 和 OpenAI-compatible HTTP。
- reviewer 选择、来源与预算在任务开始时冻结，不跟随后来页面或前台模型变化。写入权限不能因此冻结：后来开启审批或关闭写入应收紧旧任务，不能放宽原来要求审批的任务。
- 请求没有编码工具、hooks、MCP 或执行权限。
- 记忆单 job 的摘要／review／标签使用同一个 invoker，共享调用次数、输入／输出和总时间预算；技能相似性调用计入技能 job 的预算。
- 记忆 invoker 硬上限为 6 次、24000 输入 token、4000 输出 token、120000 ms。输入估算不是供应商实测用量。
- 请求中断后输出用量可能未知；不得写成“0 token／0 成本”。
- 协议纠正最多一次；冲突、恢复失败和同来源 replay 不自动再次收费。

## 前台优先与关闭

普通前台发送只预占已派发的后台工作，已经完成、尚未派发的回顾保留在等待队列，等所有前台任务结束后由空闲事件唤醒。显式 Stop 和关闭相应模块才取消等待队列；不靠定时轮询，也不重放已取消或已尝试的收费请求。

已经 dispatch 到宿主的事务不能仅因为随后取消就改报 cancelled；须等待真实 applied／conflicted／needs_recovery 等结果。

跨记忆与技能的共享协调以 renderer 为边界，不代表不同进程或多个已安装实例具有全局互斥。持久化候选与记忆事务仍通过宿主锁／CAS 防止竞争。

关闭自动学习不删除已经保存的记忆、技能、候选或历史，不授予脚本执行权限，也不自动回滚过去的成功事务。重新开启不应自动重放曾失败或取消的收费请求。

## 记忆批次与存储

- 审批针对原 workspace 的完整批次，不使用审批页面当前项目代替来源项目。
- `add`／`update`／`remove` 通过严格完整响应解析；未知字段、未解析残余和不完整预筛不能成为授权。
- 更新与删除使用原始 base 的精确 CAS；并发手动编辑必须显示冲突，不覆盖后续修改。
- 每个目标事务绑定 receipt，确认目标保存后再确认 pending queue。queue 确认失败时，重试应核对同一个 receipt，不重复修改目标。
- user 与 project 库分别提交；没有跨库全局原子性。部分成功须保留实际 applied 数量和失败诊断。
- 缺来源／base 的旧 pending 批次不可直接批准。明确确认流程也不能猜测当前页面就是原 workspace；无法建立可信来源时只能保持待确认或拒绝。
- full 与 compact 记忆上下文使用相同 freezeKey，并恢复原版本；历史范围按每条消息的 createdAt 过滤，不只按会话创建时间过滤。

记忆 job journal 位于 app-owned `memories/review-jobs.v1.json`，用于持久化尝试来源、水位、终态和用量。它不是目标文件的写入凭据，不能代替目标事务读回。记忆撤销也必须是保留审计的**新 CAS 事务**；没有完整 before 记录的旧 receipt 不得伪造可撤销能力。

### 聊天中的真实状态

技能与记忆回顾使用颜色和文字共同显示排队、进行、待审批、无新增、失败和取消。没有结果对象也可显示真实状态；只有宿主确认的实际操作数量才能支持“已保存”。没有达到门槛的技能回顾带宿主生成的结构化非准入信息，不能凭模型返回的原因字符串推断“未调用模型”。

记忆状态绑定原 workspace／session／user turn 与 producer 捕获的原助手 ID。新 journal 保留该助手 ID，重加载仍显示在原回复处；重复或不匹配的 ID 不选择任意一个回答。旧 journal 缺少 ID 时只做有限兼容定位，不退回最新无关回答。持久化的进行中状态没有实时 producer 时显示“未确认结束”，不伪装当前活动，也不自动再次调用模型。

待审批状态可以打开实际设置对话框，再进入“记忆”页审批。设置页入口存在不代表已经批准或已经写入；仍须真实目标读回和后续任务验证。

## 技能候选、审批与回滚

本地项目候选存储使用 `.ultragamestudio/skill-learning/pre-review.v1.json`。Node 与原生宿主共享兼容的路径、revision 与锁。

- 同一 session／turn 的重试不会增加连续候选次数。
- 候选来源、提交 batch 和目标 revision 保留历史，不通过清空 submitted 或 replay fence 来“重新开启”。
- 一批最多创建一个新的类级技能；Rust 和 Node 宿主都检查实际 absent-before 包数量，包括旧 pending 的 approve 入口。
- 一个 create 与已有技能的合法追加 patch 可以混合；替换／删除旧规则不能仅因为新文本非空而自动判为安全。
- 批准、拒绝、回滚先核对真实宿主结果，再 CAS 同步对应 candidate submission。辅助同步失败不得把真实 applied 变成 failed；诊断单独保留。
- 回滚也是新事务。目标自原提交后被手动修改则冲突，不覆盖后续修改。
- 空闲治理只生成建议。UNKNOWN 创建来源、cron 引用不明、只读、外部、pin 或非后台创建的技能保持保护，不自动归档或永久删除。

## 验收层级

| 层级 | 能证明什么 | 不能替代什么 |
| --- | --- | --- |
| L1：纯运行时／协议 | 预算、状态机、解析、判定 | 生产 caller、权限与磁盘 |
| L2：组件／调用方回归 | props、原源传递、取消与状态显示 | 原生 IPC 与真实 provider |
| L3：真实 HTTP／宿主文件／native 测试 | 真实路由、鉴权、CAS、完整文件读回、进程恢复 | 安装版 UI＋前台任务＋真实 provider 的完整闭环 |
| L4：安装版产品验收 | 从普通任务到保存、下一任务复用、冲突／关闭／恢复的实际产品行为 | 不允许用 fixture 或子代理总结替代 |

浏览器中挂载真实组件可以验收主题、320px 窄屏、键盘焦点、展开／折叠和诊断可见性；即使 DOM 全部通过，也不等于 native L4。

Windows Rust 测试若因 Common Controls v6 manifest 缺失在断言开始前退出，可通过 scratch 副本 manifest runner 运行真实 crate tests。必须披露 runner 适配；该结果不证明原安装包可以启动。

## 可复跑门禁

在 `app/` 下：

```bash
NODE_OPTIONS=--no-experimental-webstorage npm test -- --maxWorkers=4 --reporter=json --outputFile='<scratch>/learning-tests.json'
npm run typecheck
NODE_OPTIONS=--no-experimental-webstorage npm run build
npm run cli:build
npm run check:prompt-lock
npm run check:built-in-workflows
```

全量报告必须在所有共享工作树 writer 结束后生成。比较起始工作树基线中的具体失败名称与 suite error，而不是仅比较总数。不能 reset／stash 用户改动来制作“干净”基线。

### 两个普通任务的 HTTP／文件验收

`src/lib/skillLearningLive.integration.test.ts` 包含默认运行的 L3 场景：

1. 两个不同普通任务各执行真实 child-process 检查：缺产物失败，写入项目产物后同一脚本成功。
2. 不使用 `/learn`，不预置第一条 candidate；经过真实 HTTP fixture reviewer，第一次只累计，第二次进入审批。
3. 用真实 Node 宿主批准，读取实际完整 `SKILL.md`。
4. 新来源任务读入同一 revision 的完整内容；检查送达而不冒称遵循。
5. 用真实宿主回滚，并检查文件确实不存在。

同一文件另有可选真实 reviewer 场景，只有 `UGS_LIVE_REVIEW_KEY`、`UGS_LIVE_REVIEW_MODEL`、`UGS_LIVE_REVIEW_URL` 都存在于测试进程环境时才运行。不设默认供应商、模型或硬编码地址，不读取凭据文件，凭据不得放进结果或聊天。供应商输出可能合法 noop；测试未达验收预期时报告实际失败，不伪造技能。

```bash
NODE_OPTIONS=--no-experimental-webstorage npm test -- src/lib/skillLearningLive.integration.test.ts --maxWorkers=1
```

这个可选场景仍是**真实 reviewer＋脚本化前台任务**，不是安装版 L4。

### 发布前仍须实际执行

- 在真实安装版中产生原生工具证据，等待确切用户消息落盘，再观察独立 HTTP reviewer。
- 两个普通来源任务累计候选，实际批准；重启后读取同一技能与事务历史。
- 下一相关任务核对发出的完整技能内容；若要宣称遵循，运行绑定同一 revision 的专门宿主检查。
- 手动改目标后尝试批准／撤销，确认 CAS 冲突且原字节不变。
- 在派发前、模型返回前、宿主提交期间分别 Stop；检查无晚到写入，已提交结果仍如实报告。
- 关闭／重开／重启，历史与旧原源仍保留，不自动重计费。
- 核对记忆批次 legacy 确认、完整 diff、真实撤销和恢复诊断在实际设置面板可达。

没有上述安装版和供应商证据时，不将完整计划标为可发布。

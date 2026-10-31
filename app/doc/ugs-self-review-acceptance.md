# 自复盘发布验收记录

这是可审计的验收记录，不是再次规划，也不是发布完成声明。原始范围见 [开发计划第 9 节](../../.hermes/plans/2026-10-26_211126-ugs-self-review-complete-plan.md#9-验收矩阵不能只验证已有模块)。L1／L2／L3 不能关闭安装版＋真实供应商 L4 承诺。

## 已执行检查点

证据根：`C:/Users/fengwei/AppData/Local/hermes/cache/scratch/ugs-self-review-development/`。

| 检查点 | 实际结果 | 解释 |
| --- | --- | --- |
| `tests-visible-before.json` | 3303 passed／2 failed／69 skipped | 本轮起始 dirty 工作树；两项 CLI 失败 |
| `tests-post-review.json` | 3420 passed／2 failed／69 skipped；无 suite error | 失败为 duplicate-assistant 定位及旧技能 noop 隐藏预期；不是全量绿色 |
| `aidock-visible-final.json` | 92 passed／0 failed／0 skipped | 两项以上问题修复／契约更新后的四文件；尚不代替最终全量 |
| `typecheck-post-review.log` | exit 0 | 后续提交政策修复前检查点 |
| `prompt-lock-post-review.log` | exit 0 | 同上 |
| `native-all-skill-visible.log` | 92 passed／0 failed／1 ignored | 真实 crate skill 过滤；不能沿用旧的其他过滤计数 |
| `native-memory-post-review.log` | 主过滤 14 passed／0 failed／3 ignored | 另有 fresh-process 子执行记录；使用 scratch manifest runner，不与主计数相加 |
| `desktop-preflight-build.log` | exit 0 | `npm run cli:build`＋正式 identifier `tauri build --no-bundle` 检查点 |
| `native-qa-build.log` | exit 0 | 隔离 identifier EXE；不是最终正式包 |
| `native-qa-process.json` | 隔离 QA PID 128632、native window 可响应 | 本地 deterministic HTTP fixture；GUI 点击授权超时，未执行后续产品流程 |

### 尚未关闭的门禁

- 提交政策第二轮修复：模型已返回或目标锁等待时启用审批，旧合法提案不能直接落盘；不增加模型调用，不放宽原任务审批。
- 修复后所有 writer 结束，再执行最终全量、类型、构建与独立审查。
- 重建正式 EXE并记录最终源文件／二进制哈希。旧 EXE检查点不作为最终版本。
- GUI 测试需工具授权；真实 provider＋安装版闭环尚无证据。

## 全部发布场景

“相关自动化证据”指已有回归入口，不代表本行已经在 L4 完成。每一行安装版验收均保持 **未验证**；remote／GUI 主入口仍受能力与退休护栏约束。

| ID | 场景 | 相关自动化入口／记录 | L4 判定 |
| --- | --- | --- | --- |
| A01 | HTTP 失败，不启动 CLI | review gateway／invoker／refresh budget | 未验证 |
| A02 | source append 失败不授予读写 | useStore.review-source／source native readback | 未验证 |
| A03 | A 项目提案在 B 页审批 | memoryPending／candidate controls | 未验证 |
| A04 | legacy pending 无来源 | memoryPending.confirmation／migration | 未验证 |
| A05 | 超限、存储失败保留 pending | memoryStore durability／pending transactions | 未验证 |
| A06 | 同库并发 add 无丢失 | memoryStore.native／native CAS／candidate concurrent | 未验证 |
| A07 | 第二操作失败或崩溃可恢复 | native memory transactions／skill transactions | 未验证 |
| A08 | native direct-host 两个 create 拒绝 | skills host／management create budget | 未验证 |
| A09 | 单 create＋安全已有补丁合法 | skills transactions mixed batch | 未验证 |
| A10 | memory 单个非法操作整批拒绝 | memoryProtocol／native validators | 未验证 |
| A11 | triage ID 缺失、重复、交叉 | memoryAutotag／queue CAS | 未验证 |
| A12 | 新前台、配置关闭、Stop | memory-send-preemption／submit policy／coordinator | 未验证 |
| A13 | host dispatch 后取消保留真实结果 | memoryConsolidate／skills revoke／transactions | 未验证 |
| A14 | 两个普通任务候选→待审批 | skillLearningLive.integration／CLI studio HTTP | 未验证 |
| A15 | 同源 retry、A/B/A、0.94 不计连续 | preReview／candidate store | 未验证 |
| A16 | candidate 并发、拒绝、回滚、revision | native candidate／Node host／control integration | 未验证 |
| A17 | remote 主入口与远程写 | remote client／backend candidate HTTP | 未验证，主入口能力受限 |
| A18 | 实际 GUI DAG context 与 evidence | useStore.dag-learning／runtime payload | 未验证，退休入口不开放 |
| A19 | memory／skills 同时合格 | coordinator／shared availability／admission | 未验证 |
| A20 | 长日志脱敏、有界、未知 usage | reviewCompletionGateway／budget／skills evidence | 未验证 |
| A21 | chat 真实状态与诊断历史 | AIDock／Cards／resultless retry；最新请求要求真实 noop 可见 | 未验证 |
| A22 | 彩色、长 diff、不执行 proposal HTML | Cards／reviewPresentation／source-bound controls | 未验证 |
| A23 | 明暗、320px、键盘、reduced motion | 浏览器真实组件 fixture；不是 native UI | 未验证 |
| A24 | 新任务全文／revision，旧前缀不变 | memorySnapshots／snapshot lifecycle／actual payload | 未验证 |
| A25 | 精确 host adoption，非 generic 成功 | runtime skills adoption／scope receipts | 未验证，不宣称实际采用 |
| A26 | rollback 重启与生命周期保护 | memoryStore.rollback／native transactions／lifecycle | 未验证 |

## 复验规则

1. 普通任务不得以手动 `/learn`、预置 candidate 或伪造聊天来源代替。
2. `applied` 以 exact target fresh read、receipt／revision 为依据；pending resolved 和模型总结不证明保存。
3. 后续复用要检查实际 outgoing payload；旧 session 的冻结快照不应被重写。
4. 宿主已派发事务的真实 applied／recovery 不被晚到取消覆盖；已尝试任务不自动重计费。
5. UI、fixture、脚本化 HTTP、真实 native 文件测试与真实 provider 分层记录。
6. 只清理本任务创建的 QA 进程／目录；不停止用户程序，不 reset／stash／提交／推送，不读取凭据。

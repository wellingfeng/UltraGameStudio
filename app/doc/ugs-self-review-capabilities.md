# 记忆复盘与技能自动学习能力表

本文区分源码能力、自动化回归与安装版验收。**当前不是完整发布通过证书。** 行为与权限说明见 [学习运行时](learning-runtime.zh-CN.md)，场景清单见 [验收记录](ugs-self-review-acceptance.md)。

| 能力 | 当前边界 | 证据及未关闭项 |
| --- | --- | --- |
| 独立后台模型 | completion-only HTTP；无编码 CLI 回退 | 网关预算／取消回归与 HTTP fixture；真实供应商安装版未验收 |
| 可信来源 | 精确 user source 持久化和 fresh read；技能原生宿主独立校验 | producer／native 回归；不把 optimistic cache 当落盘 |
| 技能候选 | 不同任务连续两次高度相似才提交；重试不累计 | 普通任务 HTTP＋真实 Node 文件宿主集成；安装版普通工具任务未验收 |
| 记忆事实与技能规则 | 独立协议、审批与生命周期，不自动双写 | 协议及协调回归；不宣称模型参数训练 |
| 前台优先 | active 预占与 pending 显式取消分离；事件唤醒、有界队列 | 真实 `sendPrompt` 回归；多进程间不承诺 renderer 全局互斥 |
| 审批权限收紧 | 原任务 require 与当前 policy 取更严格结果 | 排队收紧回归通过；模型返回后／锁等待中的最终提交边界仍在修复验收 |
| 聊天彩色状态 | 真 queued／active／approval／noop／failed／cancelled 可显示，无结果也可诊断 | 真实 AIDock／Card 四文件 92 项回归通过；安装版颜色与交互尚未关闭 |
| 非准入说明 | 仅宿主结构化 marker 表示未触发，模型原因字符串不证明未调用 | producer、表示层及真实模型 noop 文本回归 |
| 记忆原回复绑定 | source＋assistant ID；journal 持久化 ID；重复 ID 拒绝任意选择 | 实时／重加载挂载回归；旧 journal 仅有限兼容 |
| 审批与撤销 | 原 scope、原 base、精确 CAS、真实宿主目标读回 | 真实文件／native 事务回归；实际设置面板审批与撤销未完整验收 |
| 后续任务复用 | 新 session 冻结完整新记忆；旧 session 保留原快照 | snapshot／actual payload 回归；安装版供应商请求未验证 |
| 技能送达与采用 | 全文与 revision 送达不等于采用；仅专门精确 host check 才能计采用 | Node 实际 payload 回归；没有检查证据时只报 delivered |
| 远程 | 候选客户端／服务端 CAS，不允许 local fallback | 路由／鉴权回归；退休 Cloud 主入口不开放，不据此宣称远程产品全面支持 |
| GUI DAG | 生产 context／evidence 接线保留；GUI 退休护栏不解除 | producer 回归；安装版实际 DAG 运行未验收 |
| 治理 | 首次观察不归档；UNKNOWN／pin／cron／external 等保护；仅建议 | 生命周期回归；不自动永久删除或执行生成脚本 |
| Windows 桌面构建 | 正式 identifier 与隔离 QA identifier 均曾 `--no-bundle` 成功 | 是检查点产物；最新修复后还需重建。未覆盖、重启用户程序 |

## 安装版与供应商边界

隔离 QA EXE 使用独立 `UGS_HOME`、独立 app identifier 和无凭据的本地 HTTP fixture。进程与原生窗口可响应，**这不证明普通聊天、审批保存、新会话读取或撤销已通过**。原生 workspace 点击未获得工具授权，GUI 验收已暂停，不通过别的路径绕过该拒绝。

真实供应商学习与效果没有验收；不能把 deterministic HTTP 返回、已有 memory 文件、测试总数或 EXE mtime 当成记忆提升。当前已运行的用户程序也未因源码或 `dist` 更新而自动换成新 EXE。

最终交付必须绑定所有 writer 结束后的全量报告、独立审查结论、最终二进制哈希及实际产品场景。未验证部分持续保持 limited／pending，不标成 supported-and-accepted。

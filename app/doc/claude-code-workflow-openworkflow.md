# Claude Code 有了 Dynamic Workflows，那其他大模型怎么办？有开源版的替代-OpenWorkflows

## 最近一直在看 Claude Code 新推出的 dynamic workflows，相比于MCP、Skill、Hooks等很少有人讨论这个新功能。(后面我们统一叫workflows)

复杂的任务，很多人之前喜欢先做调研html，然后再转成技术方案的html，最后再交给AI来开发，但是很多时候发现结果并不好。最主要的原因是html是给人看的文本信息，它不是Script，缺少结构化信息，顺序一致性、任务并行程度、边界是否清晰、任务如何划分、任务之间如何交换信息 等都是不明确，更多依赖AI去猜测。

而workflows本身就是Script，它能彻底的解决这个问题。

另外workflows还有多角度探索、对抗性验证、方案投票机制，这也就是为什么它准确率更高的原因，靠规模取胜，同一个问题让5个agents同时去跑，然后再由一个agent汇总起来，确实更准确了，token也花的的飞起。

既然这么具有通用性，它为什么要绑在某一个模型或某一个 CLI 上？

顺着这个思路，我开发了 OpenWorkflows(更确切的说是AI开发的)。它把 Claude Code 这类 workflows 做成可视化画布，并尝试让同一份流程面向 Claude Code、Codex、Gemini，甚至更多本地或云端运行时。

这次我不讲抽象概念，直接按截图走一遍。例子也很具体：让 OpenWorkflows支持多种界面风格，默认使用 Pencil，并且能在“设置 / 外观”里切换。

在开发过程中，我尽量在OpenWorkflows中进行，让它能够自举。

以下过程使用CodeX来作为默认大模型用于开发。

### 0. 先看最终界面

<p align="center">
  <img src="images/0-标题使用.png" alt="OpenWorkflows 主界面" width="960">
</p>

OpenWorkflows的主界面，中央是 workflows 蓝图，右侧是节点属性，底部是 AI 输入和返回。

OpenWorkflows的主界面大概分成四块：左侧是 workflows 历史，中央是可视化画布，右侧是节点属性和常用提示词，底部是 AI 输入与返回。

### 1. 下载 OpenWorkflows

<p align="center">
  <img src="images/1-下载.png" alt="OpenWorkflows GitHub Releases" width="840">
</p>

从 GitHub 项目页右侧的 Releases 找到最新版。

### 2. 先配置大模型

默认会使用系统配置好的cli来启动，你可以使用CC-Switch等来配置。

### 3. 新建 workflows ，然后输入需求

<p align="center">
  <img src="images/3-新建workflow.png" alt="新建 workflows 并输入需求" width="840">
</p>

配置好模型后，点击左侧“新建 workflows ”。画布上会出现一个最小结构：Start、一个 Agent、End。

这里不需要真的动手动画节点，而是右下角的 AI 输入框。这个例子里，我输入的是：

```text
我希望为 OpenWorkflows 支持多种界面风格，
默认用 Pencil 来设计，
并且在“设置 / 外观”中可以切换。
```

写完后可以按 Ctrl+Enter 发送，也可以点右下角的发送按钮。OpenWorkflows会把这段自然语言转成一张可编辑的 workflows 蓝图。

### 4-1. 生成 workflows 蓝图

<p align="center">
  <img src="images/4-1生成workflow蓝图.png" alt="生成 workflows 蓝图" width="960">
</p>

发送需求后，OpenWorkflows会先把当前步骤整改成一个完整 workflows 。

截图里的蓝图大致是这样的：

```text
Start
  -> 并行梳理外观支持方案
      -> 现有外观入口调研
      -> 多风格体系设计
      -> Pencil 默认风格设计
  -> 汇总实现方案
  -> 实现多界面风格
  -> 接入设置外观切换
  -> 验证与回归检查
  -> 记录交付结果
  -> End
```

右侧节点属性里可以看到选中节点的属性可以继续修改，当然更多的时候还是在底部的输入框让AI来修改蓝图节点，可以持续迭代。

### 4-2. 查看生成脚本

<p align="center">
  <img src="images/4-2蓝图脚本.png" alt="生成的 workflows 脚本" width="960">
</p>

顶部有一个“脚本”入口。点开以后，会出现当前蓝图生成的脚本。

截图里能看到 parallel(...) 和 agent(...) 这样的结构。并行节点会变成并发执行的分支，普通节点会变成一个个 agent 调用。

这里其实也能说明 OpenWorkflows不是单纯画图。画布背后有统一的 workflows 结构，后面才能继续接不同运行时。

### 5. 用右侧常用提示词继续改

<p align="center">
  <img src="images/5-使用常用提示词.png" alt="使用常用提示词继续修改 workflows" width="960">
</p>

蓝图生成后，不一定马上运行。右侧“常用提示词”更适合用来继续打磨流程，当然也可以自己手写。

这里的提示词按场景分组，比如互动澄清、清晰度、完整性、成本、结构、可靠性、性能与并行、验证与测试。

截图里点的是“澄清需求”。它会把一段提示填入 AI 输入框，要求 AI 在修改蓝图前先用交互方式确认关键含糊点。

这个设计很实用。很多 workflows失败不是因为模型不会做，而是因为目标、边界、失败路径和成本策略一开始没有说清楚。

另外还有拷问我(grill-me)、补全边界条件、并行优化、单一原则等等常用的提示词，你也可以自己新加或者修改提示词。

### 6. 在交互选择里确认边界

<p align="center">
  <img src="images/6-交互选择.png" alt="交互选择确认边界" width="640">
</p>

点了“澄清需求”以后，AI 没有直接改图，而是先问：“背版切换功能要落地到什么范围？”

截图里给了两个选项：只落地 Pencil 默认风格并预留扩展结构，或者同时落地 Pencil 及多套可切换风格。

你选完以后，AI 才会把这个决定写回 workflows 蓝图，并输出更新后的 IRGraph。这个步骤能减少“AI 自作主张改错方向”的问题。

### 7. 点击运行

<p align="center">
  <img src="images/7-运行.png" alt="点击运行 workflows" width="960">
</p>

等蓝图结构、模型配置和关键边界都确认后，再点顶部的“运行”。

这里建议不要一生成蓝图就跑。先看并行分支是否合理，汇总节点是否在并行分支之后，验证节点是否覆盖到最后结果。

如果某个节点只是职责不清，可以先在节点属性里改后再运行。

### 8. 观察运行状态

<p align="center">
  <img src="images/8-运行中.png" alt="观察 workflows 运行状态" width="960">
</p>

运行后，顶部按钮会变成“运行中…停止”。底部 AI 输入会被锁定，避免在执行中把蓝图改乱。

画布上会显示节点状态。截图里 Start 已完成，后面的并行节点正在执行，右上角也有运行计数，如果中间失败了可以继续之前的任务。

### 9. 切换界面风格

<p align="center">
  <img src="images/9-切换风格.png" alt="切换界面风格" width="840">
</p>

等待 OpenWorkflows开发完成后，重启程序，在“设置 / 外观”中点击切换不同风格外观。

截图里可以看到 Pencil、深邃午夜、极光、日光、余烬等风格卡片。选中某个风格后，会影响全局背景、面板、边框和运行状态颜色。

### 我觉得真正有用的地方

OpenWorkflows最有价值的地方，不是把 prompt 包了一层 UI。

它把“需求 -> 蓝图 -> 脚本 -> 运行 -> 回看历史”串起来了。你可以先用自然语言生成流程，再在画布上检查结构，必要时用常用提示词补边界，最后才运行。

同一份 workflows 也不必天然绑定某一个模型。简单节点可以用便宜模型，关键节点可以用更强模型，执行目标也可以继续扩展到 Claude Code、Codex、Gemini 或其他运行时。

对复杂 AI 编程任务来说，这种拆法比一个超长 prompt 更容易维护。某个节点失败了，就改那个节点；某条分支不需要，就删那条分支；想复用，就从历史里继续改。

### 现在还早，但方向值得看

workflows 这整个概念整体都还比较早，OpenWorkflows本身也还刚开始。运行时适配、节点能力和脚本生态都还会继续变。

但整体方向是清晰：AI 编程不会长期停留在“开一个聊天框，然后手动推进每一步”。

复杂任务最后一定会变成 workflows，因为能被看见、编辑、迁移和复用。

QQ群：149523963

项目地址：

https://github.com/wellingfeng/OpenWorkflows

参考：

https://code.claude.com/docs/en/workflows

# Claude Code workflows 很好，但贵模型额度不够用怎么办？

## Claude Code 新推出的 dynamic workflows，比 MCP、Skill、Hooks 低调很多。(后面统一叫 workflows)

复杂任务里，很多人会先做调研 html，再转成技术方案 html，最后交给模型实现。但结果经常不稳定。主要原因是 html 是给人看的文本，不是 script。顺序一致性、任务并行程度、边界是否清晰、任务怎么划分、任务之间怎么交换信息，这些都不明确，模型只能猜。

workflows 本身就是 script，这类结构问题可以直接放进流程里处理。

workflows 还能做多角度探索、对抗性验证和方案投票。同一个问题让 5 个 agents 同时跑，再由另一个 agent 汇总，结果通常更稳，token 也烧得很快。

既然这么具有通用性，它为什么要绑在某一个模型或某一个 CLI 上？

FreeUltraCode 做的是这件事：把 Claude Code 这类 workflows 做成可视化画布，再让同一份流程可以跑向 Claude Code、Codex、Gemini，以及更多本地或云端运行时。

下面按一个真实改动走：让 FreeUltraCode 支持多种界面风格，默认使用 Pencil，并且能在“设置 / 外观”里切换。

开发过程尽量放在 FreeUltraCode 里完成，顺便验证它能不能自举。

下面用 Codex 作为默认大模型。

### 0. 主界面

<p align="center">
  <img src="images/0-标题使用.png" alt="FreeUltraCode 主界面" width="960">
</p>

FreeUltraCode的主界面，中央是 workflows 蓝图，右侧是节点属性，底部是 AI 输入和返回。

FreeUltraCode的主界面大概分成四块：左侧是 workflows 历史，中央是可视化画布，右侧是节点属性和常用提示词，底部是 AI 输入与返回。

### 1. 下载 FreeUltraCode

<p align="center">
  <img src="images/1-下载.png" alt="FreeUltraCode GitHub Releases" width="840">
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
我希望为 FreeUltraCode 支持多种界面风格，
默认用 Pencil 来设计，
并且在“设置 / 外观”中可以切换。
```

写完后可以按 Ctrl+Enter 发送，也可以点右下角的发送按钮。FreeUltraCode会把这段自然语言转成一张可编辑的 workflows 蓝图。

### 4-1. 生成 workflows 蓝图

<p align="center">
  <img src="images/4-1生成workflow蓝图.png" alt="生成 workflows 蓝图" width="960">
</p>

发送需求后，FreeUltraCode会先把当前步骤整改成一个完整 workflows 。

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

这里其实也能说明 FreeUltraCode不是单纯画图。画布背后有统一的 workflows 结构，后面才能继续接不同运行时。

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

等待 FreeUltraCode开发完成后，重启程序，在“设置 / 外观”中点击切换不同风格外观。

截图里可以看到 Pencil、深邃午夜、极光、日光、余烬等风格卡片。选中某个风格后，会影响全局背景、面板、边框和运行状态颜色。

### 我觉得真正有用的地方

FreeUltraCode最有价值的地方，不是把 prompt 包了一层 UI。

它把“需求 -> 蓝图 -> 脚本 -> 运行 -> 回看历史”串起来了。你可以先用自然语言生成流程，再在画布上检查结构，必要时用常用提示词补边界，最后才运行。

同一份 workflows 也不必天然绑定某一个模型。简单节点可以用便宜模型，关键节点可以用更强模型，执行目标也可以继续扩展到 Claude Code、Codex、Gemini 或其他运行时。

对复杂 AI 编程任务来说，这种拆法比一个超长 prompt 更容易维护。某个节点失败了，就改那个节点；某条分支不需要，就删那条分支；想复用，就从历史里继续改。

### 现在还早，但方向值得看

workflows 这整个概念整体都还比较早，FreeUltraCode本身也还刚开始。运行时适配、节点能力和脚本生态都还会继续变。

但整体方向是清晰：AI 编程不会长期停留在“开一个聊天框，然后手动推进每一步”。

复杂任务最后一定会变成 workflows，因为能被看见、编辑、迁移和复用。

### 补充：不想开界面？命令行里两条命令就够了

上面讲的都是图形界面。但很多场景其实不需要画布——比如想把一个流程接进 CI、写进脚本、或者在服务器上无头跑。所以 FreeUltraCode 也提供了一个命令行版本，对应的 skill 叫 `/freeultracode`。

设计上我刻意把它做得很克制：**在用户这一侧，命令只有两个**。因为在命令行里，你不需要关心蓝图、IRGraph、编译这些中间概念——**workflow 对你来说就是一个 `.js` 脚本**，其余的转换全部自动发生。

```bash
fuc gen "做一个代码审查流程" -o review.js   # 用一句话生成一个 workflow 脚本
fuc gen review.js "再加一个安全审查节点"      # 用一句话修改已有脚本
fuc run review.js                          # 把脚本跑起来
```

就这三种用法（其实就 `gen` 和 `run` 两个命令）。

**`fuc gen`** 是用自然语言生成或修改 workflow。它和界面底部那个 AI 输入框是同一套能力：你说需求，它生成脚本；你指着已有脚本说怎么改，它改给你。

这里有个关键点：**它是零配置的，不需要你去填什么 API Key**。因为它复用的就是你本机已经登录好的 `claude` CLI（和运行时用的是同一条路），所以只要你装了 claude 并登录过，`fuc gen` 直接就能用。没装的话它会提醒你先 `claude login`。

**`fuc run`** 就是把脚本跑起来，逐个节点执行，终端里实时打印进度：

```text
[14:32:02] ▶ agent n_scan
[14:32:15] ✓ agent n_scan — 13.2s
[14:32:15] ▶ parallel n_review (3 个分支)
[14:32:31] ✓ parallel n_review — 16.1s
完成 — 29.8s
```

并行、流水线、对抗性验证、自动重试这些机制，和界面里点“运行”是完全一样的——因为**命令行和界面共用同一个运行内核**，只是一个把结果画到画布上，一个把结果打到终端里。

常用的几个开关：`--dry-run` 只预检不真跑（省 token）、`--resume` 从上次失败的节点接着跑、`--model` 指定模型、`--json` 输出机器可读结果方便接进流水线。

这套命令行的取舍很简单：**界面负责"看得见、改得动"，命令行负责"跑得快、接得上"，背后还是同一份 workflow。**

QQ群：149523963

项目地址：

https://github.com/wellingfeng/FreeUltraCode

参考：

https://code.claude.com/docs/en/workflows

# 注册并配置免费渠道 API Key

这篇教程演示如何在 FreeUltraCode 里给一个免费渠道补上 API Key。截图使用 OpenRouter 做例子，其他云端渠道的流程基本一致：从底部 Channel 菜单选择一个未配置的渠道，打开注册网站，创建 Key，再回到 FreeUltraCode 保存。

> 免费渠道的额度、模型和注册要求会随平台变化。以 FreeUltraCode 弹窗打开的平台官网为准，不要把自己的 API Key 发给别人，也不要把完整 Key 放进截图或公开文档。

## 适用场景

当渠道名称后面出现警告符号时，通常表示这个渠道还缺少必要配置，例如 API Key。配置完成后，警告会从该渠道名称后消失，FreeUltraCode 就能通过本地 proxy 把请求转发到对应平台。

本教程主要适用于 OpenRouter、Gemini、DeepSeek、Mistral、Kimi、Groq、Fireworks AI、Z.ai GLM 等需要云端账号或 Key 的渠道。本地渠道如 Ollama、LM Studio、llama.cpp 通常不需要注册网站，但需要先启动本地服务并确认模型名称。

## 1. 选择一个未配置的免费渠道

打开底部 **Channel** 下拉列表，选择一个还带警告符号的免费渠道。截图里选择的是 **Free · OpenRouter**。

<p align="center">
  <img src="images/注册免费渠道/1-配置大模型.png" alt="在 Channel 下拉列表中选择未配置的免费渠道" width="960">
</p>

警告符号表示 FreeUltraCode 还没有拿到这个渠道需要的配置。选中后，系统会弹出配置窗口。

## 2. 打开注册网站

在弹窗里点击 **打开注册网址**。这个按钮会跳到当前渠道对应的平台官网或 API Key 页面。

<p align="center">
  <img src="images/注册免费渠道/2-注册.png" alt="打开渠道注册网站" width="960">
</p>

不要在多个渠道之间共用同一个 Key。每个平台的 Key 只用于对应平台；如果一个渠道要求额外的 base URL、模型名或组织 ID，也按弹窗或平台页面提示填写。

## 3. 在平台页面新建 Key

登录平台账号后，进入 API Keys 页面，点击 **New Key** 或类似按钮创建新的 API Key。

<p align="center">
  <img src="images/注册免费渠道/3-新建token.png" alt="在渠道平台新建 API Key" width="960">
</p>

创建后立刻复制 Key。很多平台只会完整显示一次，关闭弹窗后就只能删除重建。建议给 Key 起一个能识别用途的名字，例如 `freeultracode`。

## 4. 回到 FreeUltraCode 保存并使用

把刚复制的 API Key 粘贴到 FreeUltraCode 的渠道配置弹窗里，然后点击 **保存并使用**。保存成功后，再打开 Channel 下拉列表，刚才配置的渠道后面应该已经没有警告符号。

<p align="center">
  <img src="images/注册免费渠道/4-配置好了.png" alt="配置完成后渠道警告符号消失" width="960">
</p>

现在可以直接在底部输入框提问。后续请求会从 FreeUltraCode 本地 proxy 转发到这个渠道。

## 5. 在设置里集中查看免费渠道

如果想一次性检查所有渠道，点击左下角 **设置**，再进入 **渠道** -> **免费渠道**。这里会列出每个渠道的状态、API Key、默认模型和 **获取 Key** 入口。

<p align="center">
  <img src="images/注册免费渠道/5-设置中的免费渠道.png" alt="在设置里查看和配置免费渠道" width="960">
</p>

状态显示 **已就绪** 的渠道已经保存了必要配置；显示 **待填 Key** 的渠道还需要补 API Key。本地渠道不一定需要 Key，但要确认本地服务已经启动，并且模型名和本地服务中的模型一致。

## 常见问题

**保存后仍然有警告符号怎么办？**

先确认 Key 是否完整复制，没有多余空格或换行。再确认选择的是同一个渠道，例如 OpenRouter 的 Key 不要填到 Gemini 渠道里。

**Key 保存了，但请求失败怎么办？**

去平台官网确认 Key 是否启用、额度是否可用、选择的模型是否允许访问。部分平台需要先在控制台启用模型、充值小额余额或同意服务条款。

**本地模型渠道也需要这样注册吗？**

不需要。Ollama、LM Studio、llama.cpp 这类本地渠道通常要检查本地服务地址、端口和模型名，而不是注册云端 API Key。

**可以把 Key 写进 workflow 脚本吗？**

不建议。Key 应保存在 FreeUltraCode 的本地渠道配置里，workflow 只负责描述任务和节点结构。

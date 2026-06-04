# FreeUltraCode

<div align="center">
  <a href="../../README.md">English</a> | 中文 | <a href="README.fr.md">Français</a> | <a href="README.de.md">Deutsch</a> | <a href="README.es.md">Español</a> | <a href="README.pt-BR.md">Português</a> | <a href="README.ru.md">Русский</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.ar.md">العربية</a>
</div>

不是每个编程任务都值得烧最贵的模型额度。FreeUltraCode 把 Claude Code、Codex、Gemini、免费渠道和本地模型放到同一个本地聊天界面里。常规任务走便宜模型，关键判断再交给更稳的模型。

<p align="center">
  <strong>免费渠道路由</strong><br>
  <img src="images/hero-free-channels.zh-CN.png" alt="FreeUltraCode 免费渠道路由截图" width="960">
</p>

## 为什么做 FreeUltraCode

AI 编程工具确实好用，但高级模型额度消耗很快。FreeUltraCode 的思路很直接：保留本地聊天体验，同时让请求可以方便地走免费、试用额度或低成本渠道。

- 支持 GitHub Models、Hugging Face Router、SambaNova Cloud、Together AI、Gemini、DeepSeek、Kimi、Groq、OpenRouter、NVIDIA NIM、Z.ai、Kilo、LLM7、Ollama、LM Studio、llama.cpp 等渠道。
- API Key 和 provider 设置保存在本机。
- 在底部输入区直接切换 runtime、channel、权限模式和 workspace。
- 会话历史、收藏夹、定时提示词和 workspace 上下文都保存在本机。
- 本地模型可以零 API Key 使用，前提是本机服务和模型已准备好。

## 主要能力

### 编程 Chat

- 让 AI 修改代码、排查 Bug、重构、补测试、写发布说明或文档。
- 支持附加文件路径，也可以把文件拖进输入区。
- 在同一个聊天界面查看流式输出、命令日志、文件引用和总结。
- 可以在同一个会话里继续追问，不需要重复解释上下文。

### 免费大模型路由

- **20+ 个远程渠道 + 本地运行时**：NVIDIA NIM、OpenRouter、GitHub Models、Hugging Face Router、SambaNova Cloud、Together AI、Google Gemini、DeepSeek、Mistral、Mistral Codestral、OpenCode、Wafer、Kimi、Cerebras、Groq、Fireworks、Z.ai、LLM7、Kilo Gateway，以及 Ollama、LM Studio、llama.cpp 等本地运行时。
- **免 Key 实验渠道**：LLM7 和 Kilo Gateway 可以不填 API Key 直接试用，但只建议用于非敏感编程任务。
- **官方免费/试用额度渠道**：GitHub Models、Hugging Face Router、SambaNova Cloud、Together AI、Gemini、Groq、Cerebras、NVIDIA NIM、OpenRouter、Mistral/Codestral、DeepSeek、Kimi、Z.ai、OpenCode、Wafer、Fireworks 等需要填写 provider API Key，Key 只保存在本机。
- 内置 Rust 本地反向代理，自动翻译 Anthropic 和 OpenAI-compatible 协议。
- Claude Code 可以通过已经配置好的免费渠道路由，不需要改聊天界面。
- API Key、模型覆盖值和本地模型配置都可以在设置里管理。

当前默认的编程向模型：

| 渠道 | 默认模型 |
| --- | --- |
| GitHub Models | `openai/gpt-4.1-mini` |
| Hugging Face Router | `deepseek-ai/DeepSeek-V4-Pro` |
| SambaNova Cloud | `DeepSeek-V3.1` |
| Together AI | `Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8` |
| Kilo Gateway | `poolside/laguna-xs.2:free` |
| LLM7 | `codestral-latest` |

### 本地优先

- 会话、收藏、定时提示词、API Key 和 workspace 历史都保存在本机。
- 不需要托管版 FreeUltraCode 服务。
- 桌面端可以使用本机已有的 CLI 凭据和本地模型运行时。

## 快速开始

从 `app/` 启动 Web 开发版：

```bash
cd app
npm install
npm run dev
```

Vite 默认运行在 <http://localhost:5173>。

启动桌面端开发模式：

```bash
cd app
npm run desktop
```

打包生产版桌面应用：

```bash
cd app
npm run package
```

在仓库根目录下，也可以使用 `run.bat` 自动重建并启动 Windows 应用，或使用 `build.bat` 打包 Windows 安装器。

## 使用方式

### 注册免费渠道

1. 打开底部 **Channel** 下拉列表，选择一个带警告符号的免费渠道，例如 **Free · OpenRouter**。

<p align="center">
  <img src="images/注册免费渠道/1-配置大模型.png" alt="在 Channel 下拉列表中选择未配置的免费渠道" width="960">
</p>

2. 在 API Key 弹窗里点击 **打开注册网址**。

<p align="center">
  <img src="images/注册免费渠道/2-注册.png" alt="从 API Key 弹窗打开渠道注册网站" width="960">
</p>

3. 到平台官网创建新的 API Key，并复制出来。

<p align="center">
  <img src="images/注册免费渠道/3-新建token.png" alt="在渠道平台新建 API Key" width="960">
</p>

4. 回到 FreeUltraCode 粘贴 API Key，点击 **保存并使用**。保存成功后，这个渠道后面的警告符号会消失。

<p align="center">
  <img src="images/注册免费渠道/4-配置好了.png" alt="配置完成后渠道警告符号消失" width="960">
</p>

5. 也可以从左下角 **设置** 进入 **渠道** -> **免费渠道**，集中查看每个渠道的 API Key、默认模型和配置状态。

<p align="center">
  <img src="images/注册免费渠道/5-设置中的免费渠道.png" alt="在设置里查看和配置免费渠道" width="960">
</p>

渠道状态显示 **已就绪** 后，就可以在底部输入框提问。完整步骤见 [注册并配置免费渠道 API Key](register-free-channel.md)。

### 使用 Chat 编程

1. 点击左侧 **+ 新建会话**，创建一个新的 Chat。
2. 在底部确认 runtime、channel、权限模式和 workspace。要让 AI 修改代码时，workspace 应指向当前要改的仓库。
3. 在输入区写清楚编程需求：目标行为、涉及文件、验收标准、边界条件和限制。写完后按 `Ctrl+Enter`，或点击右下角发送按钮。

<p align="center">
  <img src="images/chat/h-新建chat.png" alt="新建 Chat 会话并输入编程需求" width="960">
</p>

4. 等待执行时，观察中间区域的消息流和命令记录。FreeUltraCode 会把读取文件、搜索代码、修改文件、运行检查等步骤拆成独立记录。

<p align="center">
  <img src="images/chat/i-等待完成.png" alt="等待 Chat 执行代码检查、修改和验证" width="960">
</p>

5. 完成后，先看 AI 的结果摘要、改动范围和验证命令。如果还需要调整，直接在同一个 Chat 里继续补充要求。
6. 如果是界面功能，最后运行应用实测一次。下面这个例子里，Chat 根据需求给收藏任务增加了定时执行弹窗，并验证了周报提醒、执行时间、重复执行和运行时提醒开关。

<p align="center">
  <img src="images/chat/j-周报.png" alt="Chat 编程完成后显示定时执行任务弹窗" width="960">
</p>

## 工作原理

```text
用户请求
    |
    v
聊天输入区
    |
    +--> 选中的 runtime / channel / 权限 / workspace
             |
             +--> 直接 provider API、本地 CLI 或本地免费渠道 proxy
                        |
                        +--> 流式 AI 输出、工具日志和聊天历史
```

免费渠道 proxy：

- 只绑定 `127.0.0.1:<port>`。
- 每个渠道通过 `http://127.0.0.1:<port>/ch/<channelId>` 路由。
- 翻译 Anthropic 和 OpenAI-compatible 流式协议。
- 让 Claude Code 也能通过同一条 gateway 路径使用非 Anthropic 或本地 provider。

## 技术栈

| 范围 | 技术 |
| --- | --- |
| 桌面壳 | Tauri 2, Rust |
| 前端 | React 18, Vite 5, TypeScript 5 |
| 状态 | Zustand |
| 样式 | Tailwind CSS, CSS variables |
| 图标 | lucide-react |
| Provider routing | Claude Code、Codex、Gemini、可扩展 provider settings |
| 免费渠道 proxy | Rust `tiny_http` + `ureq`，Anthropic/OpenAI 协议翻译 |

## 项目结构

```text
app/
  src/
    components/  共享 UI 和富文本 assistant message 渲染
    lib/         Provider 设置、免费渠道路由、持久化辅助函数
    panels/      Sidebar、chat dock、settings、定时任务 UI
    store/       Zustand 状态和本地历史
  src-tauri/
    src/
      free_proxy.rs    Rust 反向代理 + Anthropic/OpenAI 协议翻译
      lib.rs           Tauri 命令、文件系统/历史桥接
  doc/                 教程、本地化 README、截图
docs/                  调研笔记、静态文档、素材
pencil/                Pencil 设计文件
```

## 相关文档

- [注册并配置免费渠道 API Key](register-free-channel.md)
- [英文 README](../../README.md)

## 开发与验证

从 `app/` 运行：

```bash
npm run dev        # Vite 开发服务器
npm run typecheck  # TypeScript 检查
npm run lint       # ESLint
npm run test       # Vitest
npm run desktop    # Tauri 开发模式
npm run package    # 生产打包
```

## 社区

- Discord: <https://discord.gg/2C9ptSEFG>
- QQ Group: `149523963`
- Issues: <https://github.com/wellingfeng/FreeUltraCode/issues>
- Repository: <https://github.com/wellingfeng/FreeUltraCode>

## 许可证

目前尚未指定许可证。

# OpenWorkflow

OpenWorkflow is a visual desktop editor for authoring AI-agent workflow scripts. It uses a blueprint-style canvas to model `agent()`, `parallel()`, `pipeline()`, and related workflow primitives, then converts between the visual graph and executable Claude Code-style scripts.

OpenWorkflow 是一个用于编排 AI Agent 工作流脚本的可视化桌面编辑器。它用蓝图式画布组织 `agent()`、`parallel()`、`pipeline()` 等工作流节点，并支持在可视化图和可执行 Claude Code 风格脚本之间转换。

## Features

- Visual node graph for AI workflow design.
- React Flow canvas with execution and data edges.
- TypeScript IR (`IRGraph`) as the single source of truth.
- Parser and emitter for script-to-graph and graph-to-script round trips.
- Tauri desktop shell with Windows packaging support.
- Local Anthropic API key storage for optional AI-assisted editing.

## 功能特性

- 使用节点图设计 AI 工作流。
- 基于 React Flow 展示执行流和数据流。
- 以 TypeScript `IRGraph` 作为统一数据模型。
- 支持脚本解析到图、图再生成脚本的往返验证。
- 基于 Tauri 打包桌面应用，当前支持 Windows 安装包。
- 可选接入 Anthropic API Key，用于 AI 辅助编辑，密钥仅保存在本机。

## Project Structure / 项目结构

```text
app/
  src/                 React + TypeScript frontend
    core/              IR, parser, emitter, round-trip logic
    canvas/            React Flow canvas and node components
    panels/            Sidebar, prompt panel, AI dock
    store/             Zustand application state
  src-tauri/           Rust/Tauri desktop backend and packaging config
docs/                  Design and workflow syntax references
pencil/                Pencil design files
run.bat                Build-if-needed and launch the Windows app
build.bat              Build the Windows release package
```

## Requirements / 环境要求

- Node.js 18+
- Rust toolchain with Cargo
- Windows 10/11 with WebView2 for packaged desktop builds

## Development / 本地开发

Run app commands from `app/`.

在 `app/` 目录执行应用开发命令。

```bash
cd app
npm install
npm run dev        # Vite dev server: http://localhost:5173
npm run desktop    # Tauri development mode
npm run typecheck  # TypeScript checks
npm run lint       # ESLint
npm run build      # TypeScript build + Vite build
npm run package    # Tauri production package
```

On Windows, you can also run from the repository root:

在 Windows 上，也可以从仓库根目录运行：

```bat
run.bat          :: rebuild if sources changed, then launch
run.bat /run     :: launch existing executable only
run.bat /build   :: build only
build.bat        :: package the Windows installer
```

## Verification / 验证方式

There is no dedicated test runner yet. Use `npm run typecheck` and `npm run lint` for baseline checks. For parser, emitter, or IR changes, start the app and run `OpenWorkflow.roundtrip()` in the browser/devtools console to verify graph-script round-trip behavior.

当前还没有独立测试框架。基础验证请运行 `npm run typecheck` 和 `npm run lint`。如果修改了解析器、生成器或 IR，请启动应用并在浏览器/开发者工具控制台执行 `OpenWorkflow.roundtrip()`，确认图与脚本的往返转换稳定。

## Download / 下载

Prebuilt Windows binaries are published on the GitHub Releases page when available. Download either the standalone `OpenWorkflow.exe` or the NSIS installer.

如果已发布预构建版本，可以在 GitHub Releases 页面下载 Windows 版本。可选择独立运行的 `OpenWorkflow.exe`，也可以下载 NSIS 安装包。

## Architecture Notes / 架构说明

`IRGraph` is the central contract. Adding or changing a workflow node type usually requires coordinated updates in:

`IRGraph` 是项目核心契约。新增或修改工作流节点类型时，通常需要同步更新：

- `app/src/core/ir.ts`
- `app/src/core/parser.ts`
- `app/src/core/emitter.ts`
- `app/src/canvas/irToFlow.ts`
- relevant files under `app/src/canvas/nodes/`

Keep parser and emitter behavior aligned so visual workflows remain recoverable from emitted scripts.

请保持 parser 与 emitter 行为一致，确保从画布生成的脚本仍能恢复为等价工作流。

## Security / 安全说明

Anthropic API keys are user-provided and stored locally in browser/WebView `localStorage`. Do not commit secrets, local `.env` files, build output, or debug logs.

Anthropic API Key 由用户自行提供，并保存在本机浏览器/WebView 的 `localStorage` 中。不要提交密钥、本地 `.env` 文件、构建产物或调试日志。

## License / 许可证

No license has been specified yet.

当前尚未指定开源许可证。

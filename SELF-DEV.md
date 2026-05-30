# 在 OpenWorkflow 里开发 OpenWorkflow（自举 / Self-Dev）

你想用 OpenWorkflow 跑工作流来改 OpenWorkflow 自己的源码。难点：**真正执行工作流的 `claude -p` 只在 Tauri 桌面壳里有**（浏览器里只会模拟），而开发命令 `npm run desktop`（`tauri dev`）会**监听源码**——工作流一改 `app/src/**` 或 Rust，它就热更新/重启 webview，正在跑的工作流（等 `ai_cli` 返回的 Promise）随之全部丢失，运行中断。

核心原则：**让“运行实例”和“被修改的源码”互不影响。**

## 一键脚本：`run.bat`（已合并“打包 + 启动”）

```
run.bat            自动判断：源码比 exe 新就先打包，然后启动独立 exe
run.bat /run       只启动现有 exe（不打包、不检查，秒开）
run.bat /build     只打包、不启动
```

- 启动的是 `app\src-tauri\target\release\OpenWorkflow.exe`——**自包含**：前端打进二进制、Rust 编译进去，**运行时不读任何源码**。
- 在它里面跑工作流去改 `app\src\**` / `src-tauri\**` —— **不受源码改动影响，运行不中断**。
- auto 模式用 PowerShell 比较“最新源码 mtime vs exe mtime”决定是否重打包；不需要时跳过、秒启动。
- 每次双击 `run.bat` 都会 `start` 一个**新的独立进程/窗口**，可同时开多个（你在用的 A 实例 + 自测启动的 B 实例互不冲突）。

### 多实例为什么不冲突
- 打包 exe **不起 dev server**，不抢 5173 端口（那是 `tauri dev` 才用的）。
- 运行进度事件按 `runId` 过滤，且 Tauri `emit` 只发本进程窗口 → 跨实例不串台。
- localStorage 每个 webview 独立；自测把“选择工作区”指到**副本**，autosave 也不会互相覆盖。

手动等价：`run.bat /build` ≈ `cd app && npm run package`；`run.bat /run` ≈ 直接双击那个 exe。

## 方案 B：改独立副本（更安全、可审阅 diff）

1. 把项目复制一份，例如 `E:\OpenWorkflow-dev`（`app/` 当前还不是 git 仓库，要用 worktree 得先 `git init`，否则直接拷贝）。
2. runner 跑**主副本**的 exe（`run.bat`）。
3. 运行工作流前，把底部 **“选择工作区”指到 `E:\OpenWorkflow-dev`**，权限设为“完全访问权限”。
4. agent 只改副本，主副本/runner 一动不动；你审阅副本改动、合并回主、再 `run.bat`（会自动重打包）。

## 不要用作 runner

`npm run dev` / `npm run desktop`（=`tauri dev`）监听源码，会被你工作流的源码改动触发重载/重启，自己把自己中断。它们仍是**普通人工开发**的命令，只是不适合“一边跑工作流一边改自己源码”的自举场景。

## 安全提醒

“完全访问权限”= 工作流里的 agent 在工作区内可**读/写/执行 Bash**。自举改源码必然要写权限；优先用方案 B（改副本）把影响隔离在副本里。

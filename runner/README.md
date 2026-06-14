# FreeUltraCode Remote Runner（远程执行后端 · 路线 B）

让你在 **FreeUltraCode 桌面端输入指令，但任务实际在你自己的云服务器上执行**。
代码同步用 Git，模型调用用你配置的 CLI（claude / codex / gemini），密钥既可放在
服务器上、也可由客户端按任务下发。整套后端零三方依赖，只需 Node 20+ 与 git。

```
FreeUltraCode 桌面端
  ──(HTTPS + Bearer Token)──▶  fuc-remote-runner（你的云服务器）
                                  ├─ git clone/pull 仓库
                                  ├─ 调用 claude/codex/gemini CLI 改代码、跑命令
                                  ├─ git diff 生成 patch
                                  └─ 可选 commit & push 到新分支
  ◀──(SSE 实时日志 + 结果/patch)──┘
```

## 快速开始

### 方式 A：直接用 Node 运行

```bash
cd runner
cp .env.example .env
# 必填：生成一个强 Token
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
# 把它写进 .env 的 FUC_RUNNER_TOKEN，并按需填入模型 key
npm start
```

### 方式 B：Docker

```bash
cd runner
export FUC_RUNNER_TOKEN=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")
docker compose up -d --build
```

服务器需要安装你要用的 Agent CLI（`claude` / `codex` / `gemini`）并保证它们在 `PATH` 中。

## 在桌面端接入

打开 FreeUltraCode → 左上角工作区切换器 → **添加远程工作区**，填入：

- 服务器地址：`https://your-server:8787`
- 访问 Token：与 `FUC_RUNNER_TOKEN` 相同
- （可选）默认仓库、分支、Adapter、模型
- （可选）自己的模型 API Key / Base URL —— 不填则用服务器上配置的 key

点「测试连接」验证 `/health` 通过后保存。该工作区会出现在工作区列表里，标记为「远程」。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 无需鉴权。返回服务信息、是否要求 Token、支持的 adapter |
| POST | `/jobs` | 创建任务。body: `{prompt, repoUrl?, branch?, adapter?, model?, pushBranch?, apiKey?, baseUrl?, gitToken?}` |
| GET | `/jobs` | 任务列表（不含任何密钥） |
| GET | `/jobs/:id` | 单个任务（含日志、结果/patch） |
| GET | `/jobs/:id/stream` | SSE 实时日志与状态、最终结果 |
| POST | `/jobs/:id/cancel` | 取消任务 |

除 `/health` 外所有接口都要求 `Authorization: Bearer <FUC_RUNNER_TOKEN>`。

## 安全说明

- **鉴权默认失败关闭**：未配置 `FUC_RUNNER_TOKEN` 时，所有受保护接口一律拒绝。
- **密钥不回显**：客户端下发的 `apiKey` / `baseUrl` / `gitToken` 只用于当次任务，
  任务结束即从内存与持久化记录中删除，且永不通过 API 返回。
- **凭证脱敏**：clone/push 输出中的 `token@host` 会被替换为 `***@host` 再回传。
- **生产环境务必前置 HTTPS**（如 Caddy / Nginx 反代），不要让明文 Token 走公网。
- 这是会执行任意 git/构建命令的服务，请仅暴露给可信网络或加 IP 白名单。

## 配置项（环境变量）

见 `.env.example`。常用：

- `FUC_RUNNER_TOKEN`（必填）访问令牌
- `FUC_RUNNER_PORT` 监听端口，默认 8787
- `FUC_RUNNER_WORKDIR` 任务工作目录
- `FUC_RUNNER_MAX_CONCURRENCY` 最大并发任务数
- `FUC_RUNNER_JOB_TIMEOUT` 单任务超时（秒）
- `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` 服务器侧默认模型 key

## 测试

```bash
cd runner
npm test
```

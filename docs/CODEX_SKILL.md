# Agent Bridge Codex 接入

## 一条命令

```text
npx -y codex-agent-bridge
```

然后新开一轮 Codex。MCP 段由安装器写入，`command` 为本机 `node.exe`，运行时在 `~/.agent-bridge`，不要手写 `npx.cmd` / `tsx.cmd`。

开发者从本仓库接入：

```text
npx tsx src/cli.ts setup --dev
```

## MCP 形态

```toml
[mcp_servers.agent-bridge]
command = "<node.exe>"
args = ["--import", "tsx", "<packageRoot>/src/mcp/server.ts"]
cwd = "<packageRoot>"
startup_timeout_sec = 30

[mcp_servers.agent-bridge.env]
NODE_PATH = "<node_modules>"
```

Windows 上 Node 直接 spawn `.cmd` / `.bat` 会 EINVAL，所以 MCP 的 `command` 用 `node.exe` + `--import tsx`，不要用 `npx.cmd` / `tsx.cmd`。若某 Worker 只提供 `.cmd` shim，那是该 Worker 的启动兼容问题，不是「Windows 永远禁止 `.cmd`」。改完配置后需要新开一轮 Codex 才会看到工具。

本地自检：

```text
npm run mcp:smoke
```

Skill 源文件：`skills/agent-bridge/SKILL.md`  
用户级副本：`~/.codex/skills/agent-bridge/SKILL.md`

V1 的 `bridge_run` **只选择 `worker`**（`claude` / `deepseek` / 调试 `replay` / `fake`）。Codex **不得虚构** `model` / `provider` / `effort` 参数；这些由用户在 Worker 原生配置里预先设好，Bridge 启动时继承。Claude 走官方 Anthropic、CC Switch 或其他第三方 Provider 是 Worker 内部实现，Bridge 不感知。

安装前提：用户至少已有一个可独立正常运行、完成认证和配置的 Worker。Agent Bridge 负责检测，不负责配置 Worker 模型或第三方 Provider。

`approve` 只在任务分支打 checkpoint 并拆掉 worktree。要把结果落到当前分支，用 `bridge_apply`（cherry-pick，禁止 merge）。项目里若有 `.agent-bridge/verify.json`，默认会跑其中全部 verifyId。

Phase 2 诊断：`bridge_doctor`、`bridge_agents`、`bridge_status` 的 `needsAttention`。遗留 worktree 用 `bridge_prune`。MCP 默认 permission gate：`WAITING_FOR_INPUT` 时用 `bridge_respond`。`timeoutMs` 到期为 `TASK_TIMED_OUT`（可 continue）。Core 重启后 in-flight 任务变为 `AWAITING_REVIEW` + `interrupted`，用 `continue`。改完 MCP 工具列表后需要新开 Codex 会话。

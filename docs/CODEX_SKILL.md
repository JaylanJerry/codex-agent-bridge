# Agent Bridge Codex 接入

## MCP（已用 `codex mcp add` 注册）

```toml
[mcp_servers.agent-bridge]
command = 'C:\Program Files\nodejs\node.exe'
args = ["--import", "tsx", 'C:\Users\jjbon\Documents\Codex\Agent Relay\src\mcp\server.ts']
cwd = 'C:\Users\jjbon\Documents\Codex\Agent Relay'
startup_timeout_sec = 30

[mcp_servers.agent-bridge.env]
NODE_PATH = 'C:\Users\jjbon\Documents\Codex\Agent Relay\node_modules'
```

Windows 不要用 `npx.cmd` / `tsx.cmd`。改完配置后需要新开一轮 Codex 才会看到工具。

本地自检：

```text
npm run mcp:smoke
```

Skill 源文件：`skills/agent-bridge/SKILL.md`  
用户级副本：`~/.codex/skills/agent-bridge/SKILL.md`

`approve` 只在任务分支打 checkpoint 并拆掉 worktree。要把结果落到当前分支，用 `bridge_apply`（cherry-pick，禁止 merge）。项目里若有 `.agent-bridge/verify.json`，默认会跑其中全部 verifyId。

Phase 2 诊断：`bridge_doctor`、`bridge_agents`、`bridge_status` 的 `needsAttention`。遗留 worktree 用 `bridge_prune`。MCP 默认 permission gate：`WAITING_FOR_INPUT` 时用 `bridge_respond`。改完 MCP 工具列表后需要新开 Codex 会话。

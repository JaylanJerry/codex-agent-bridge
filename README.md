# Agent Bridge

Codex 监督 Claude Code 或 DeepSeek Harness。Bridge **不调用 LLM**。

仓库目录仍可能叫 Agent Relay，产品名是 Agent Bridge。V1 入口是 Codex MCP stdio，不是 HTTP daemon / GUI / 单文件 EXE。

## 前提

用户**至少已有一个**可以独立正常运行、完成认证和配置的 Worker（Claude Code 或 DeepSeek Harness）。Agent Bridge 负责检测，**不负责**配置 Worker 的 model、provider、reasoning effort，也不配置 CC Switch 或其他第三方 Provider。

需要：

- Windows 或 POSIX，已安装 Git
- Node.js（用 `node.exe` 启动 MCP，不要用 `npx.cmd` / `tsx.cmd`）
- 本仓库已 `npm install`

## 安装

在本仓库：

```text
npm install
npx tsx scripts/install.ts --write-mcp
```

脚本会：

1. 把 `skills/agent-bridge/SKILL.md` 拷到 `~/.codex/skills/agent-bridge/SKILL.md`
2. 若缺少 `[mcp_servers.agent-bridge]`，追加到 `~/.codex/config.toml`（`command` 为当前 `node.exe`）
3. 跑 `doctor`（检测 Git / Node / Skill / MCP / Worker 是否已配置）

改完 MCP 后需要**新开一轮 Codex** 才会看到 `bridge_*` 工具。

自检：

```text
npm test
npm run mcp:smoke
npx tsx src/cli.ts doctor
```

## Worker 配置（V1）

`bridge_run` **只选择 `worker`**：`claude` / `deepseek`（调试可用 `replay` / `fake`）。

不要传 `model` / `provider` / `effort`。Claude 走官方 Anthropic、CC Switch 或其他第三方 Provider 都是 Worker 内部实现；Bridge 启动时继承用户已有的持久配置。

## 闭环

```text
bridge_run
→ WAITING_FOR_INPUT 时 bridge_respond
→ AWAITING_REVIEW + ReviewPacket
→ bridge_approve（任务分支 checkpoint）
→ bridge_apply（cherry-pick 到当前分支，不是 merge）
```

Turn 结束不是任务完成。Worker 不得 commit / push / merge / rebase。

## journal 保留

`.agent-bridge-data/journal.ndjson` 超过约 8 MiB 时轮转，最多保留 5 个历史文件（`journal.ndjson.1` … `.5`）。`bridge_prune` 拆终态/孤儿 worktree；**默认不删** `agent-bridge/*` 任务分支。

同一项目同一时刻只能有一个 Writer（MCP 或 CLI）。第二写者返回 `CORE_LOCK_HELD`。崩溃留下的 `core.lock`：若原 pid 已死，下一个 Writer 接管；无法判定死活则 fail-closed。不要手动乱删锁文件。损坏的 `tasks.json` 返回 `TASK_STORE_CORRUPTED`，不会当成空任务库。

## 卸载

1. 从 `~/.codex/config.toml` 删除 `[mcp_servers.agent-bridge]` 段
2. 删除 `~/.codex/skills/agent-bridge/`
3. 可选：删除各仓库的 `.agent-bridge-data`
4. 不改用户 git config；不删任务分支，除非用户明确 `prune` 策略允许

## 文档

现行路线：`docs/PRODUCT_GUIDE.md`  
裁决：`docs/decisions/ADR-001-post-mvp-direction.md`（Accepted）  
Codex 接入：`docs/CODEX_SKILL.md`

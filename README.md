# Agent Bridge

**Codex 监督 Claude Code 和 DeepSeek Harness。Bridge 自己不调用 LLM。**

[![npm](https://img.shields.io/npm/v/codex-agent-bridge.svg)](https://www.npmjs.com/package/codex-agent-bridge)
[![node](https://img.shields.io/node/v/codex-agent-bridge.svg)](https://www.npmjs.com/package/codex-agent-bridge)
[![license](https://img.shields.io/npm/l/codex-agent-bridge.svg)](./LICENSE)

Let Codex be the only supervisor. Claude Code or DeepSeek Harness does the implementation. You review, verify, and apply in Codex.

---

## What it is

Codex 负责计划、审核、approve / apply。外部 Coding Agent 只在独立 worktree 里改代码。Bridge **不调用任何 LLM**，也不替你选 model / provider / effort。

```text
Codex  ──bridge_run──►  Claude Code / DeepSeek Harness
  ▲                         │
  │      ReviewPacket       │  在独立 worktree 里改代码
  │      verification       │  不得 commit / push / merge
  └──── bridge_apply ◄──────┘
```

## Features

- MCP 工具：`bridge_run` → `respond` → `review` → `approve` → `apply`
- Worker 在独立 git worktree 干活，不得 commit / push / merge
- 独立 verification，不信 Worker 自称测过
- ReviewDigest、checkpoint、CAS、guarded cherry-pick
- `doctor` 自检：缺什么、为什么、怎么修

## Quick Start

别人看到 README 后按这五步走，不用翻文档。

### 1. Install

需要 Node.js 22+ 和 Git。

```bash
npx -y codex-agent-bridge
```

这条命令会：把运行时装到 `~/.agent-bridge`，写入 Codex Skill 和 MCP（用本机 `node.exe`，不用 `npx.cmd`），并跑一次 `doctor`。

更新再跑同一条。卸载：

```bash
npx -y codex-agent-bridge uninstall
npx -y codex-agent-bridge uninstall --purge
```

### 2. Configure Claude or DeepSeek

Bridge **不安装** Worker，也不改它们的 model / provider / reasoning effort。你至少要有一个已经能独立登录、独立干活的 Worker：

| Worker | 你要先做好 |
| --- | --- |
| Claude Code | 本机已安装并完成登录 |
| DeepSeek Harness | 本机已能独立跑；legacy ACP 需要源码树或 `AGENT_BRIDGE_DEEPSEEK_ROOT`，以及 `DEEPSEEK_API_KEY` |

Agent Bridge不管理DeepSeek model/provider/reasoning effort。DeepSeek effective route由运行中的Harness ACP composition决定。当前legacy integration使用上游composition配置。Claude Code 沿用其原生配置。

### 3. Run doctor

```bash
npx -y codex-agent-bridge doctor
npx -y codex-agent-bridge doctor --project /path/to/your/git-repo
```

成功时会看到：

```text
✓ Agent Bridge installed
✓ Git available
✓ Claude ACP available
✓ DeepSeek ACP legacy available
✓ Workspace ready
```

某一项是 `✗` 时，doctor 会写：缺少什么、为什么、怎么解决。不要忽略 `Fix:` 行。

### 4. Connect the MCP client

安装后**新开一轮 Codex**。旧会话看不到新的 `bridge_*` 工具。

MCP 已由安装器写入 `~/.codex/config.toml`。不要手写 `npx.cmd`。

### 5. First task

目标必须是独立 git 仓库。每次 `bridge_*` 都带同一个 `project`。任务 UUID 字段名是 `task`。

```text
bridge_run          worker=claude 或 deepseek
→ WAITING_FOR_INPUT 时 bridge_respond
→ AWAITING_REVIEW + ReviewPacket
→ bridge_approve     任务分支 checkpoint，不是完成发布
→ bridge_apply       cherry-pick 到当前分支，不是 merge
```

Turn 结束 ≠ 任务完成。Diff 只认 `baseCommit` vs worktree。`bridge_run` **只选 worker**，不要传 `model` / `provider` / `effort`。

项目里如果有 `.agent-bridge/verify.json`，默认会跑其中全部 verifyId。示例：`templates/verify.json`。

---

## Architecture

```text
Codex (Supervisor)
  │ MCP stdio
  ▼
Agent Bridge
  ├── TaskManager / worktree / verification / review
  ├── checkpoint + CAS + guarded apply
  └── WorkerProfile → AcpRuntimeDriver
        ├── Claude official ACP
        └── DeepSeek legacy source ACP
```

更细的说明：

| | |
| --- | --- |
| 产品路线 | [docs/PRODUCT_GUIDE.md](docs/PRODUCT_GUIDE.md) |
| Codex 怎么接 | [docs/CODEX_SKILL.md](docs/CODEX_SKILL.md) |
| 为什么走 npm、不走 EXE | [docs/decisions/ADR-003-npm-distribution.md](docs/decisions/ADR-003-npm-distribution.md) |
| 为什么不做 HTTP/GUI | [docs/decisions/ADR-001-post-mvp-direction.md](docs/decisions/ADR-001-post-mvp-direction.md) |
| DeepSeek 官方 automation 边界 | [docs/decisions/ADR-004-deepseek-official-automation-boundary.md](docs/decisions/ADR-004-deepseek-official-automation-boundary.md) |

## Limitations

- DeepSeek 当前是 **legacy source ACP**，不是官方 Product runtime。官方 ACP runtime 迁移等上游补入口，见 ADR-004。
- 同一项目同一时刻只能有一个 Writer。第二写者返回 `CORE_LOCK_HELD`。
- 损坏的 `tasks.json` 会 `TASK_STORE_CORRUPTED`，不会当成空库。
- 没有 GUI、HTTP daemon、SQLite。审核面在 Codex。
- V1 不管理 Worker 的 model / provider / effort。

## 从源码开发

```bash
npm install
npx tsx src/cli.ts setup --dev
npm test
```

`--dev` 让 MCP 指向当前仓库，而不是 `~/.agent-bridge`。

## License

Apache-2.0. See [LICENSE](./LICENSE).

Roadmap: [ROADMAP.md](./ROADMAP.md). Changes: [CHANGELOG.md](./CHANGELOG.md).

## 发布新版本

本地 `npm publish` 每次都会要 2FA。正确做法是：**改版本 → 打 tag → push**，GitHub Actions 用 Trusted Publishing 发 npm。

仓库目录可能仍叫 Agent Relay。产品名是 Agent Bridge。npm 包名是 `codex-agent-bridge`。

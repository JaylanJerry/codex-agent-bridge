# Agent Bridge

**Codex 监督 Claude Code 和 DeepSeek Harness。Bridge 自己不调用 LLM。**

[![npm](https://img.shields.io/npm/v/codex-agent-bridge.svg)](https://www.npmjs.com/package/codex-agent-bridge)
[![node](https://img.shields.io/node/v/codex-agent-bridge.svg)](https://www.npmjs.com/package/codex-agent-bridge)
[![license](https://img.shields.io/npm/l/codex-agent-bridge.svg)](./LICENSE)

Let Codex be the only supervisor. Claude Code or DeepSeek Harness does the implementation. You review, verify, and apply in Codex.

---

## 一条命令

```bash
npx -y codex-agent-bridge
```

然后**新开一轮 Codex**。你会看到 `bridge_*` 工具。

这条命令会：把运行时装到 `~/.agent-bridge`，写入 Codex Skill 和 MCP（用本机 `node.exe`，不用 `npx.cmd`），并跑一次 `doctor`。

更新再跑同一条。卸载：

```bash
npx -y codex-agent-bridge uninstall
npx -y codex-agent-bridge uninstall --purge
```

`--purge` 会删掉 `~/.agent-bridge`。

### 你需要先有

| 必须 | 说明 |
| --- | --- |
| Node.js 22+、Git | 用来跑 Bridge |
| Codex | 唯一 Supervisor |
| Claude Code **或** DeepSeek Harness | 至少一个已经能独立登录、独立干活 |

### 我们不管

- 不帮你安装 Claude Code / DeepSeek Harness
- 不改它们的 model / provider / reasoning effort
- 不调用任何 LLM

有哪个 Worker，就能派哪个。一个都没有时，`doctor` 会标明。

---

## 它做什么

```text
Codex  ──bridge_run──►  Claude Code / DeepSeek Harness
  ▲                         │
  │      ReviewPacket       │  在独立 worktree 里改代码
  │      verification       │  不得 commit / push / merge
  └──── bridge_apply ◄──────┘
```

闭环：

```text
bridge_run
→ WAITING_FOR_INPUT 时 bridge_respond
→ AWAITING_REVIEW + ReviewPacket
→ bridge_approve     任务分支 checkpoint，不是完成发布
→ bridge_apply       cherry-pick 到当前分支，不是 merge
```

Turn 结束 ≠ 任务完成。Diff 只认 `baseCommit` vs worktree。

`bridge_run` **只选 worker**：`claude` 或 `deepseek`（调试可用 `replay` / `fake`）。不要传 `model` / `provider` / `effort`。Agent Bridge不管理DeepSeek model/provider/reasoning effort。DeepSeek effective route由运行中的Harness ACP composition决定。当前legacy integration使用上游composition配置。Claude Code 沿用其原生配置。

DeepSeek 当前仍是 **legacy source ACP**（依赖 Harness 源码树里的 example 入口）。如果不在常见路径，设置 `AGENT_BRIDGE_DEEPSEEK_ROOT`。这不是官方 Product runtime，也不应再扩张。

---

## 使用注意

- 目标必须是独立 git 仓库。每次 `bridge_*` 都带同一个 `project`。任务 UUID 字段名是 `task`。
- 同一项目同一时刻只能有一个 Writer。第二写者返回 `CORE_LOCK_HELD`。
- 改完 MCP 必须新开 Codex，旧会话看不到新工具。
- 损坏的 `tasks.json` 会 `TASK_STORE_CORRUPTED`，不会当成空库。

---

## 发布新版本

本地 `npm publish` 每次都会要 2FA，这是 npm 的规定，没法改成和 `git push` 一样免密。

正确做法是：**改版本 → 打 tag → push**，GitHub Actions 用 Trusted Publishing 发 npm，不再输入密码。

一次性配置（只需做一次）：打开 [codex-agent-bridge 的 npm 设置](https://www.npmjs.com/package/codex-agent-bridge/access) → **Trusted Publisher** → GitHub Actions，填：

| 字段 | 值 |
| --- | --- |
| Organization or user | `JaylanJerry` |
| Repository | `codex-agent-bridge` |
| Workflow filename | `publish.yml` |
| Allowed actions | `npm publish` |

之后每次：

```bash
# 先改 package.json 里的 version，提交
git tag v1.2.0
git push origin main --tags
```

## 从源码开发

```bash
npm install
npx tsx src/cli.ts setup --dev
npm test
```

`--dev` 让 MCP 指向当前仓库，而不是 `~/.agent-bridge`。

---

## 文档

| | |
| --- | --- |
| 产品路线 | [docs/PRODUCT_GUIDE.md](docs/PRODUCT_GUIDE.md) |
| Codex 怎么接 | [docs/CODEX_SKILL.md](docs/CODEX_SKILL.md) |
| 为什么走 npm、不走 EXE | [docs/decisions/ADR-003-npm-distribution.md](docs/decisions/ADR-003-npm-distribution.md) |
| 为什么不做 HTTP/GUI | [docs/decisions/ADR-001-post-mvp-direction.md](docs/decisions/ADR-001-post-mvp-direction.md) |
| DeepSeek 官方 automation 边界 | [docs/decisions/ADR-004-deepseek-official-automation-boundary.md](docs/decisions/ADR-004-deepseek-official-automation-boundary.md) |

仓库目录可能仍叫 Agent Relay。产品名是 Agent Bridge。npm 包名是 `codex-agent-bridge`。

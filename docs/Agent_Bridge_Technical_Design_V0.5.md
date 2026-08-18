# Agent Bridge 技术设计 V0.5

**状态：** Implementation Frozen Baseline  
**日期：** 2026-08-18  
**上级文档：** `Agent_Bridge_Technical_Design_V0.4.md`（架构决策仍有效）  
**仓库：** `C:\Users\jjbon\Documents\Codex\Agent Relay`

V0.4 仍是架构基线。V0.5 冻结 **Phase 0 实测结论** 和 **Phase 1 已实现接口**。实现以本文件与 `src/` 为准；与 V0.4 草稿冲突时，以本文件为准。

---

## 1. Phase 0 冻结结论

| 项 | 结论 |
|---|---|
| DeepSeek Harness ACP | **CONDITIONAL GO**：initialize / session / 两轮 prompt / `end_turn` / permission / cancel 均过。Windows 上 Worker 不能当测试执行器（bash `E_ACCESSDENIED`，无 WSL）。无 `session/load`。 |
| Claude Code ACP | **GO**：两轮改代码 + 真跑 `npm test` + cancel + permission + usage。`session/load` 跨进程 cold resume 成功。 |
| OpenCode | **DEFERRED**。不要再加 Profile，直到 DeepSeek + Claude Core 稳定。 |
| ACP Runtime | **GO**。同一个 `@agentclientprotocol/sdk` Client 驱动多个 Worker。抽象是 Runtime Driver + Worker Profile，不是每家一套 Adapter。 |
| Codex 入口 | **MCP 优先，CLI 永久保留**。live A/B 均 exit 0。Windows CLI 多一层 PowerShell quoting。 |
| Diff | 必须比较 `baseCommit` 与当前 worktree。禁止把 `base..HEAD` 当变更来源。 |
| Verification | 只跑 `.agent-bridge/verify.json` 的 `verifyId`。不信 Worker 自称测过。 |
| Ownership | `bridge-owned` 在 Windows 上用 Job Object `KILL_ON_JOB_CLOSE`。`external-owned` 不断开后仍活，Bridge 不得杀。 |
| Crash | worktree / journal 保留。不 reattach 死 pid。标 `interrupted` 并进入 `AWAITING_REVIEW`。 |
| Resume | Claude：允许 `session/load`。DeepSeek：只能 **REHYDRATE**（新 session + 目标/备注/worktree 现状）。 |
| Packaging | **Node-compatible**。本机 Node v24.18.0 可加载 ACP SDK。不锁 Bun。 |
| Core 智能 | Bridge **绝不调用 LLM**。 |

Worker 范围：只稳定 **DeepSeek Harness** 与 **Claude Code**。

---

## 2. 冻结的实现接口

### 2.1 CLI（与 TaskManager 共用同一 Core）

已实现：

```text
run
status [--needs-attention]
wait
review-packet
diff
approve
continue
respond
reject
cancel
apply
logs
doctor
agents
version
prune
```

未实现（Phase 2 其余项）：SQLite、loopback HTTP daemon、Session TTL / stall daemon、interactive question 全文（目前只闸 ACP permission）。

MCP stdio server 已提供与 CLI 相同的命令，走 `src/api/client.ts`。同一 MCP 进程内 Core 单例，live ACP session 可跨 `bridge_*` 调用存活。

`status --needs-attention` / `bridge_status.needsAttention` 只返回仍需 Supervisor 处理的任务：`AWAITING_REVIEW`、`WAITING_FOR_INPUT`、`FAILED`、`TASK_TIMED_OUT`，或非终态的 `interrupted`。`CANCELLED` / `COMPLETED` 即使带了 `interrupted` 也不列入。

`doctor` 检查 git / Node / Job Object / Worker 适配器 / **凭证是否存在（不打印值）** / Codex MCP 注册；若给了 `project`，再检查 `verify.json` 和遗留 `agent-bridge/` worktree。终态任务占用的 worktree 也算遗留。`prune` / `bridge_prune` 拆掉这些 worktree，保留任务分支。

`continue` 在 Core 重启后会把持久化的 `sessionId` 传给 Runtime：Claude 走 `session/load`，失败则 `session/new` + REHYDRATE。DeepSeek 无 load，直接 REHYDRATE。Journal 写入前脱敏。hydrate 时 `QUEUED` / `STARTING` / `RUNNING` / `VERIFYING` / `WAITING_FOR_INPUT` 一律收成 `AWAITING_REVIEW` + `interrupted`（没有 live Worker）。状态变化会立刻写入 `tasks.json`。

`approve` 后会拆掉 task worktree，checkpoint 留在任务分支。`apply` 把 `approvedCommit` cherry-pick 到 `project` 当前分支，**不是 merge**。

破坏性命令必须带 `--state-version`。不匹配则 `STATE_VERSION_CONFLICT`。

`run` 必须带 `clientRequestId`（CLI 可用 `--client-request-id`；缺省生成）。内容相同返回同 taskId；内容不同 `TASK_ALREADY_EXISTS`。

### 2.2 状态机（Phase 1）

```text
QUEUED → STARTING → RUNNING → WAITING_FOR_INPUT? → VERIFYING? → AWAITING_REVIEW
RUNNING ↔ WAITING_FOR_INPUT     # permission gate / respond
AWAITING_REVIEW → RUNNING          # continue
TASK_TIMED_OUT → RUNNING           # continue after wait budget
AWAITING_REVIEW → FINALIZING → COMPLETED  # approve
任意允许边 → FAILED / CANCELLED
RUNNING / STARTING / VERIFYING / WAITING_FOR_INPUT → TASK_TIMED_OUT  # wait 预算到期，停 Worker，保留 worktree
```

MCP 默认 `permissionMode=gate`：ACP `requestPermission` 进入 `WAITING_FOR_INPUT`，Codex 调 `bridge_respond`。CLI 默认 `auto`（选 `allow_once`）。Core 重启后 live waiter 消失，hydrate 把 `WAITING_FOR_INPUT` 收成 `AWAITING_REVIEW` + `interrupted`，用 `continue` 而不是 `respond`。

Turn 结束 ≠ 任务完成。只有 Codex `approve` 后才 `COMPLETED`。

### 2.3 Runtime

```text
ReplayRuntimeDriver   # 测试与 CLI 无 LLM 闭环
AcpRuntimeDriver      # DeepSeek / Claude / fake ACP
```

`WorkerProfile.launch.cwd` 是 **进程 cwd**（DeepSeek 必须是 harness 根）。`session/new` 的 `cwd` 永远是 **task worktree**。

Windows 上不要 spawn `.cmd`（EINVAL）。用 `node.exe` 或真实 `.exe`。

Claude 适配器路径相对于仓库，不要 `resolve("../../acp-claude")` 相对 cwd。

### 2.4 Workspace

- 默认 `git worktree add agent-bridge/<taskId> -b agent-bridge/<taskId>`
- Worker 不得 commit / push / merge / rebase
- `approve` 只在任务分支打 checkpoint commit（`git -c user.name=agent-bridge`，不改用户 git config）
- 不自动合并主分支

### 2.5 ReviewPacket

无 LLM。字段：objective、acceptanceCriteria、workerStopReason、verification、diffstat、changedFiles、warnings。

`approve` 前若 ChangeSet hash 与最近一次 `review-packet` 不一致 → `review drift`，拒绝执行。

---

## 3. Resume 策略（冻结）

```text
Claude Code
  live session  → 同进程第二轮 prompt
  cold resume   → session/load（已实测）
  crash         → 不 reattach pid；AWAITING_REVIEW + interrupted
                 Codex 决定 continue（可尝试 load，失败则 REHYDRATE）

DeepSeek Harness
  live session  → 同进程第二轮 prompt
  cold resume   → 无 session/load → 只能 REHYDRATE
  crash         → 同上，不假装会话还在
```

---

## 4. Phase 1 已有测试（必须保持绿）

```text
npm test
```

覆盖：状态机、ChangeCollector（含 leading-space porcelain）、worktree checkpoint、replay 两轮+approve、幂等、crash drain、review drift、cancel、verify allowlist、Job Object kill-on-close、fake ACP write+cancel+loadSession、CLI run/continue/approve、MCP doctor、journal 脱敏、hydrate 后 continue 传 sessionId。

---

## 5. 明确仍不做

- OpenCode Profile
- GUI
- 完整 SQLite / HTTP Core daemon
- 改用户全局 git config
- Bridge 调 LLM
- 把 `base..HEAD` 当 diff
- 信任 Worker 的测试输出替代 Verification Runner

---

## 6. 下一步（Phase 2 剩余）

已落地本轮：`doctor` / `agents` / `version`、needs-attention、journal redaction、Claude `session/load`、`prune`、MCP Core 单例、`WAITING_FOR_INPUT` + `bridge_respond` permission 闸、wait 预算 → `TASK_TIMED_OUT`、hydrate 收 in-flight + 状态落盘。

仍未做（明确推迟）：

1. ACP interactive question 全文（非 permission 的提问）
2. loopback HTTP Core daemon + SQLite
3. Session TTL / 无事件 stall 探测（目前只按 `timeoutMs` 硬截止）

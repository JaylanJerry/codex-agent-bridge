---
name: agent-bridge
description: Delegate implementation to an external coding agent through Agent Bridge. Use when Codex should supervise Claude Code or DeepSeek Harness instead of editing the target repo itself. Covers bridge_run, continue, approve, apply, reject, cancel, doctor, agents, prune.
---

# Agent Bridge

Codex 是 Supervisor。Worker 是外部完整 Coding Agent。Bridge **不调用 LLM**。

MCP server 名：`agent-bridge`  
工具前缀：`bridge_*`

## 什么时候用

用户要改一个 git 仓库，且应该由 Claude Code 或 DeepSeek Harness 执行。

## 什么时候不用

- 只问问题、读代码、做设计
- 没有 git 仓库
- OpenCode（当前 DEFERRED）
- Codex 自己改当前工作区即可

## 闭环

```text
bridge_run
→ 读 structuredContent.reviewPacket（含 verification）
→ verification.passed=false 时不要 approve，除非用户明确要求
→ 不通过：bridge_continue（notes + stateVersion）
→ 再读 ReviewPacket
→ 通过：bridge_approve（stateVersion）
→ 用户要落到当前分支时：bridge_apply（cherry-pick，不是 merge）
```

`worker`：调试用 `replay`；真干活用 `claude` 或 `deepseek`。

项目里如果有 `.agent-bridge/verify.json`，`bridge_run` 会默认跑其中全部 verifyId。也可显式传 `verifyIds`。示例：`templates/verify.json`。

破坏性调用必须带**当前** `task.stateVersion`。冲突时不要重试旧版本。

`clientRequestId` 相同且内容相同会返回同一 task；内容不同会 `TASK_ALREADY_EXISTS`。

掉线后先 `bridge_status`（`needsAttention: true`）或 `bridge_doctor`。`doctor` 标出遗留 worktree 时用 `bridge_prune` 拆掉；不会删任务分支或 checkpoint，也不会动进行中的任务。

## 硬规则

- turn 结束 ≠ 任务完成
- Worker 不得 commit / push / merge / rebase
- 不要用 `base..HEAD` 当 diff；以 ReviewPacket / `bridge_diff` 为准
- 不要信 Worker 自称测过；验证只认 `.agent-bridge/verify.json` 的 verifyId
- approve 后 worktree 会拆掉，checkpoint 留在任务分支；落到当前分支用 `bridge_apply`（cherry-pick）
- 不要 merge
- crash / 死 pid：不要 reattach；看 `interrupted`。`bridge_continue` 会尝试 Claude `session/load`；失败或 DeepSeek 则 REHYDRATE
- DeepSeek 没有 `session/load`；Claude 可以 cold load
- `bridge_logs` / journal 会脱敏，不要把密钥写进 notes

# Codex Skill：Agent Bridge

Codex 是 Supervisor。Worker 是外部完整 Coding Agent。Bridge **不调用 LLM**。

启动 MCP：

```text
node --import tsx src/mcp/server.ts
```

工作目录必须是 Agent Bridge 仓库根，或把 `tsx`/`src` 写成绝对路径。Windows 不要 spawn `.cmd`。

---

## 什么时候委派

用户要改一个 git 仓库，且应该由 **Claude Code 或 DeepSeek Harness** 执行，而不是 Codex 自己改文件。

## 什么时候不要用 Bridge

- 只问问题、读代码、做设计；
- 没有 git 仓库；
- 需要 OpenCode（当前 DEFERRED）；
- 只要 Codex 自己改当前工作区。

---

## 闭环

```text
bridge_run
→ 等待 AWAITING_REVIEW（run 已 wait）
→ 读 structuredContent.reviewPacket
→ 不通过：bridge_continue（带 notes + stateVersion）
→ 再读 ReviewPacket
→ 通过：bridge_approve（带 stateVersion）
→ 检查 approvedCommit 在任务分支，不要 merge 主分支
```

破坏性调用必须带 **当前** `task.stateVersion`。冲突时不要重试旧版本。

`clientRequestId` 相同且内容相同会返回同一 task；内容不同会 `TASK_ALREADY_EXISTS`。

---

## 硬规则

- turn 结束 ≠ 任务完成；
- 不要让 Worker commit / push / merge / rebase；
- 不要用 `base..HEAD` 当 diff；以 ReviewPacket / `bridge_diff` 为准；
- 不要信 Worker 自称测过；验证只认 `.agent-bridge/verify.json` 的 verifyId；
- crash / 死 pid：不要 reattach；看 `interrupted`，必要时 `bridge_continue` 做 REHYDRATE；
- DeepSeek 没有 `session/load`；Claude 可以 cold load。

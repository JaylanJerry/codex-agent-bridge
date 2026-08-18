# Agent Bridge 产品指导（现行）

**日期：** 2026-08-19  
**效力：** 开发与发布以本文 + `docs/decisions/ADR-001-post-mvp-direction.md` 为准。  
**与旧文冲突时：** ADR-001 与本文 > V0.5 实现接口 > V0.4 愿望清单。`IMPLEMENTATION_ROADMAP.md` 只作历史。

仓库仍叫 Agent Relay，产品名是 **Agent Bridge**。

---

## 1. 产品是什么

Codex 是唯一 Supervisor。Claude Code 或 DeepSeek Harness 是 Worker。Bridge **不调用 LLM**。

已在本机 Codex 上跑通：

```text
bridge_run
→ WAITING_FOR_INPUT 时 bridge_respond
→ AWAITING_REVIEW + ReviewPacket（独立 verify.json）
→ bridge_approve（任务分支 checkpoint，拆 worktree）
→ bridge_apply（cherry-pick 到当前分支，不是 merge）
```

Turn 结束不是任务完成。Worker 不得 commit / push / merge / rebase。Diff 只认 `baseCommit` vs worktree。

---

## 2. 现在做到哪

| 层 | 状态 |
|---|---|
| ACP Runtime（Claude / DeepSeek / fake / replay） | 已落地 |
| 状态机、worktree、验证、approve/apply | 已落地 |
| MCP stdio + CLI 共用 Core | 已落地 |
| permission 闸、wait 超时、hydrate in-flight | 已落地 |
| 作者机 Claude 完整闭环 | 已实测 |
| 跨进程单写者锁 | **未做（V1 P0）** |
| `tasks.json` 原子写 + 损坏 fail-closed | **未做（V1 P0）** |
| `FINALIZING` 崩溃恢复 | **未做（V1 P0）** |
| 安装 / Skill / 凭证引导 / 卸载 / retention | **未做（V1 P1）** |
| 干净机器陌生用户验收 | **UNPROVEN（V1 P1）** |
| HTTP daemon / SQLite / GUI / 单文件 EXE | **推迟（ADR-002）** |
| OpenCode 及其他 Agent | **后接 Profile** |

自动化：`npm test`。MCP 注册见 `docs/CODEX_SKILL.md`。Skill：`skills/agent-bridge/SKILL.md`。

---

## 3. 完整产品在路线 B 下指什么

不是把 V0.4 每一页都做完。

**完整可分发产品（V1）** = 内核已有 + P0 三门 + P1 安装与故障测试 + 干净机器验收通过。

**完整长期产品** = V1 之后按需：stall 提示、interactive question、更多 Worker、以及**仅在有新证据时**的 ADR-002（HTTP / SQLite / GUI / EXE）。

没有 GUI 也可以是完整 V1：审核面在 Codex。

---

## 4. 后续阶段（按这个做）

### 阶段 V1-P0 — 发布阻塞（先做）

同一 `project/.agent-bridge-data` 同时最多一个 Writer。

1. **跨进程锁**  
   第二写者（另一 MCP 或 CLI）立即 `CORE_LOCK_HELD`。不得 hydrate、不得写 `tasks.json`。
2. **原子 `tasks.json`**  
   写 temp → 成功 → atomic replace。解析失败 = `TASK_STORE_CORRUPTED`，禁止当成空任务库。
3. **`FINALIZING` 恢复**  
   hydrate 与 `needsAttention` 必须看见。区分：checkpoint 未建 / 已建但 COMPLETED 未落盘 / COMPLETED 已落盘但 worktree 未拆。确定性恢复。

清单与原文：ADR-001 Release Gates P0。

### 阶段 V1-P1 — 可分发（P0 之后）

4. `apply` 故障注入：cherry-pick 成功未 persist；kill 留在 cherry-picking。
5. 同 Task 并发：`approve`+`continue`、`respond`+`cancel`、两个 `apply` → `STATE_VERSION_CONFLICT`，禁止先改仓库再报错。
6. journal retention；`prune` 已有，补日志轮转策略。
7. 安装说明或脚本：Node、MCP 写入 `config.toml`（`node.exe` + tsx，不用 `.cmd`）、拷 Skill、凭证「有/无」检测、doctor 补 Skill/锁、卸载说明。
8. **最终验收：** 干净 Windows、不改 Bridge 源码、Claude `run → permission → verify → approve → apply`。

### 阶段 V1.x — 用起来再补

- stall：无事件 → `suspected_stall`。禁止当 turn 结束。禁止默认 cancel。`timeoutMs` 仍是 wait 硬截止。
- interactive question：仅当真实 Worker 用非 permission 提问挡住任务。
- doctor：core.lock、Skill 在位。
- OpenCode 等：只加 Worker Profile，不改状态机。

### 阶段 V2 — 仅 ADR-002

HTTP daemon、SQLite、WebView2、单文件 EXE。

需要例如：多 Codex 窗口共享同一 live Worker；跨会话保持 Agent 一直跑；JSON 单写者实测不够；必须离开 Codex 管大量任务。没有这些证据不要开。

---

## 5. 旧阶段对照（避免按错路线图）

| 旧 Phase | 现行 |
|---|---|
| 0 验证未知 | 完成。见 `phase0-findings.md`、`capability-matrix.md` |
| 1 最小闭环 | 完成。接口以 V0.5 + `src/` 为准 |
| 2 可靠性 | 部分完成。剩下 = 本文 V1-P0/P1，**不是**先上 SQLite/HTTP |
| 3 Codex MCP | 完成。入口保持 MCP stdio |
| 4 OpenCode | 后接。不要为第三个 Agent 重写 Core |
| 5 GUI/EXE/installer | installer 属 V1-P1；GUI/EXE 属 V2/ADR-002 |

---

## 6. 开发时读什么

| 目的 | 读 |
|---|---|
| 下一步做什么 | **本文** |
| 为何不走 HTTP/SQLite | `docs/decisions/ADR-001-post-mvp-direction.md` |
| 锁 / JSON / FINALIZING 证据 | `docs/decisions/ADR-001-appendix-route-b-evidence.md` |
| 已实现接口与状态机 | `docs/Agent_Bridge_Technical_Design_V0.5.md` + `src/` |
| Codex 怎么接 | `docs/CODEX_SKILL.md`、`skills/agent-bridge/SKILL.md` |
| 硬约束与早期架构思想 | V0.4（不要当 backlog） |
| 旧 sprint 列表 | `IMPLEMENTATION_ROADMAP.md`（历史） |

---

## 7. 硬约束（任何阶段不得破）

- Bridge 不调 LLM
- 不 merge、不用 `base..HEAD` 当 diff
- 不信 Worker 自称测过
- 不 reattach 死 pid
- Windows 不 spawn `.cmd`
- 安静 ≠ turn 结束

---

## 8. 当前唯一开发入口

从 **V1-P0 第 1 项：跨进程 `CORE_LOCK_HELD`** 开始，然后原子 `tasks.json`，然后 `FINALIZING` 恢复。不要并行开 HTTP 或 GUI。

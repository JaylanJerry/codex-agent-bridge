# Agent Bridge 产品指导（现行）

**日期：** 2026-08-19（同日小修订：Worker 配置策略、stale-lock、`.cmd` 表述）  
**效力：** 开发与发布以本文 + `docs/decisions/ADR-001-post-mvp-direction.md` 为准。  
**ADR-001：** **Accepted**（路线 B）。本修订不重开 A/B，不改阶段顺序。  
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
| 跨进程单写者锁 | **已落地（V1 P0）** |
| `tasks.json` 原子写 + 损坏 fail-closed | **已落地（V1 P0）** |
| `FINALIZING` 崩溃恢复 | **已落地（V1 P0）** |
| 安装 / Skill / 凭证引导 / 卸载 / retention | **已落地（V1 P1）** |
| 干净机器陌生用户验收 | **安装路径已完成；陌生机 Claude live 仍待按 README 跑一次** |
| HTTP daemon / SQLite / GUI / 单文件 EXE | **推迟（ADR-002）** |
| OpenCode 及其他 Agent | **后接 Profile** |
| Worker model / provider / effort 管理 | **不做（V1 只选 Worker，继承用户原生配置）** |

自动化：`npm test`。MCP 注册见 `docs/CODEX_SKILL.md`。Skill：`skills/agent-bridge/SKILL.md`。

---

## 3. 完整产品在路线 B 下指什么

不是把 V0.4 每一页都做完。

**完整可分发产品（V1）** = 内核已有 + P0 三门 + P1 安装与故障测试 + 干净机器验收通过。

**完整长期产品** = V1 之后按需：stall 提示、interactive question、更多 Worker、以及**仅在有新证据时**的 ADR-002（HTTP / SQLite / GUI / EXE）。

没有 GUI 也可以是完整 V1：审核面在 Codex。

---

## 3.1 V1 Worker Configuration Policy

V1 **只选择 Worker**（`claude` / `deepseek` / 调试用 `replay` / `fake`）。不选择、不管理、不覆盖：

- model
- provider
- reasoning effort
- model routing

Claude Code 与 DeepSeek Harness 由用户按各自原生方式提前配置并完成认证。Bridge 启动 Worker 时继承其**当前持久配置**。

Claude 背后走官方 Anthropic、CC Switch 或其他第三方 Provider，一律视为 **Worker 内部实现**。Bridge 不感知、不修改、不得猜测 effective upstream model。

推迟到真实需求出现后再议（不是 V1-P0/P1）：

- 按 Task 覆盖 model / effort
- Execution Profile
- Provider 管理

---

## 4. 后续阶段（按这个做）

### 阶段 V1-P0 — 发布阻塞（先做）

同一 `project/.agent-bridge-data` 同时最多一个 Writer。

1. **跨进程锁**  
   第二写者（另一 MCP 或 CLI）立即 `CORE_LOCK_HELD`。不得 hydrate、不得写 `tasks.json`。  
   **stale-lock：** 持锁进程仍活着 → 不得接管。持锁进程已退出但 `core.lock` 仍在 → 新 Writer 可接管；接管前必须确认原 pid 已死。无法判定死活时 fail-closed，保持 `CORE_LOCK_HELD`，由 `doctor` 标明占用或疑似 stale，禁止静默删锁后继续写。
2. **原子 `tasks.json`**  
   写 temp → 成功 → atomic replace。解析失败 = `TASK_STORE_CORRUPTED`，禁止当成空任务库。
3. **`FINALIZING` 恢复**  
   hydrate 与 `needsAttention` 必须看见。区分：checkpoint 未建 / 已建但 COMPLETED 未落盘 / COMPLETED 已落盘但 worktree 未拆。确定性恢复。

清单与原文：ADR-001 Release Gates P0。

### 阶段 V1-P1 — 可分发（P0 之后）

4. `apply` 故障注入：cherry-pick 成功未 persist；kill 留在 cherry-picking。
5. 同 Task 并发：`approve`+`continue`、`respond`+`cancel`、两个 `apply` → `STATE_VERSION_CONFLICT`，禁止先改仓库再报错。
6. journal retention；`prune` 已有，补日志轮转策略。
7. 安装说明或脚本 / README 完成标准：Node、MCP 写入 `config.toml`（`command` 用 `node.exe` + tsx，不要用 `npx.cmd` / `tsx.cmd`）、拷 Skill、凭证「有/无」检测、doctor 补 Skill/锁、卸载说明。前提：用户**至少已有一个**可独立正常运行、完成认证和配置的 Worker。Agent Bridge 负责检测，**不负责**配置 Worker 模型或第三方 Provider。
8. **最终验收：** 干净 Windows、不改 Bridge 源码、Claude `run → permission → verify → approve → apply`。
9. **Worker Configuration Inheritance Test：** 分别验证 Claude Code 与 DeepSeek Harness 经 Bridge **新启动**的 Session 确实继承用户已有持久 model / effort 配置。某 Worker 不继承时，只做该 Worker 的最小兼容，不建立统一模型管理系统。

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
- Windows 上 Node `spawn` 不要把 `.cmd` / `.bat` 当 `command`（EINVAL）。MCP 与 Bridge 自启动的 Node 入口用 `node.exe` 或真实 `.exe`，不要用 `npx.cmd` / `tsx.cmd`。这不是禁止一切 `.cmd`：若某 Worker 只提供 `.cmd` shim，属该 Worker 启动兼容，用已校验 argv 的受控封装，不接受自由 shell 字符串。
- 安静 ≠ turn 结束
- V1 只选 Worker；不虚构、不传入 model / provider / effort

---

## 8. 当前唯一开发入口

V1-P0 / V1-P1 自动化门已落地。不要并行开 HTTP 或 GUI。

下一阶段是 **V1.x**（stall / interactive question），或按 README 在干净机器上跑一次 Claude live 验收。从 **不要做 ADR-002** 开始。

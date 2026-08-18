# ADR-001 Appendix: Route B Evidence

**日期：** 2026-08-19  
**性质：** 实现审计。不改代码。不讨论路线 A/B。不建议 Bridge 调用 LLM。  
**主文：** `docs/decisions/ADR-001-post-mvp-direction.md`（Proposed）

证据标记：`PROVEN` = 当前代码/测试/commit 支持；`UNPROVEN` = 无测试或无运行时观测。

---

## 1. 多进程是否会同时写同一 `.agent-bridge-data`

**会。当前代码没有跨进程互斥。**

| 机制 | 作用域 | 证据 |
|---|---|---|
| `cores` Map | **仅当前 Node 进程** | `src/api/client.ts`：`const cores = new Map()`，`coreKey(projectPath)` 后复用 |
| `stateVersion` | 单进程内乐观锁 | `TaskManager.assertVersion`；跨进程双方可读到同一版本并各自写入 |
| 文件锁 / flock / PID lock | **不存在** | 全 `src/` 无 lock/flock/exclusive；`FileTaskStore.save` 直接 `writeFileSync`（`src/persistence/store.ts`） |

**两个 Codex 会话：** Codex 每个会话是否各 spawn 一个 `src/mcp/server.ts`，**UNPROVEN**（无 Codex 运行时观测）。若各 spawn 一个，则两个进程会对同一 `project/.agent-bridge-data/tasks.json` 与 `journal.ndjson` 并发读写。

**CLI + MCP：** `src/cli.ts` 与 MCP 都走 `dispatch` → `getCore`。两次进程、同一 `--project`，无互斥。**PROVEN（结构）**，双写损坏 **UNPROVEN（无测试）**。

**同进程多工具调用：** `src/mcp/server.ts` 的 `rl.on("line", async ...)` 不排队。`bridge_run` 在 `wait()` 期间可再入另一条 `tools/call`。同一 Core 上可重叠。**PROVEN（结构）**。Codex 是否串行化工具调用 **UNPROVEN**。

**V1 应明确禁止（fail-closed，尚未实现）：**

- 禁止：两个 MCP 进程、或 CLI 与 MCP、同时作为同一 `project/.agent-bridge-data` 的写者。
- 禁止：在已有写者持锁时 `getCore` 成功并 `hydrate`/`save`。
- fail-closed：占用排他锁（例如 `.agent-bridge-data/core.lock`）。第二进程立即返回 `ok: false, code: CORE_LOCK_HELD`，不读不写 `tasks.json`。锁随进程退出释放。
- 单进程内允许多 Task（见第 4 项）；禁的是**第二套 Core 实例**。

此项为规范缺口，不是现成行为。`doctor` 的 `codex-mcp` 只检查 `config.toml` 有无 `[mcp_servers.agent-bridge]`（`src/core/doctor.ts`），不检测第二进程。

---

## 2. `tasks.json` + ndjson journal：顺序、原子性、被 kill

### 写入顺序（单进程、`setState` 路径）

`TaskManager.setState`（`src/core/task-manager.ts`）：

1. 内存 `transition` + `stateVersion++`
2. `journal.append` → `appendFileSync(journal.ndjson)`（`src/persistence/journal.ts`）
3. `persist()` → `FileTaskStore.save` → `writeFileSync(tasks.json)`（`src/api/client.ts` `setPersist`）

`session-created` 在 `setState` 之外：先改 `task.sessionId` / `workerPid`，再 `journal.append("session-created")`，再 `this.persist()`。

`apply` **不走 `setState`**：先 `cherryPickToRepo`，再 `journal.append("applied")`，**TaskManager 内不 persist**。`dispatch` 在 `apply` 返回后才 `store.save`（`src/api/client.ts`）。

Journal **不参与 hydrate**。恢复只读 `tasks.json`（`FileTaskStore.load`）。`Journal.seq` 每进程从 0 起，重启后 seq 会重复。**PROVEN（代码）**。用 journal 做崩溃重放 **不存在**。

### 原子性

- `writeFileSync` 整文件覆盖，无 temp+rename，无 `fsync`。**非原子。**
- `load()` 在 `JSON.parse` 失败时返回 **空 snapshot**（`tasks: []`），不是拒绝启动。截断的 `tasks.json` 会被当成「没有任务」。**PROVEN（`store.ts` catch）**。全量丢失 **UNPROVEN（无 kill 测试）**。
- `appendFileSync` 一行 JSON。半行导致 `bridge_logs` 的 `JSON.parse` 抛错（`client.ts` logs 路径无逐行容错）。**PROVEN（结构）**。

### 中途 kill（推断自代码；无杀进程测试 → 结果标 UNPROVEN）

**state 变更（`setState`）**

- kill 在 journal 之后、`writeFileSync` 完成前：journal 有 `state-changed`，`tasks.json` 仍旧。重启 hydrate 以 **旧 JSON** 为准，journal 多出来的行被忽略。
- kill 在 `writeFileSync` 写到一半：`load` 失败 → **空任务表**（见上）。工作区 git worktree 可能仍在。

**verification**

顺序（`runTurn`）：`setState(VERIFYING)`（此时已 persist，**尚无本轮 `lastVerification`**）→ `runVerification`（同步 `spawnSync`）→ 赋 `lastVerification` → journal `verification-result` → `setState(AWAITING_REVIEW)`。

- kill 在 VERIFYING persist 之后、验证结束前：磁盘为 `VERIFYING`。hydrate（`f17b3f6`）→ `AWAITING_REVIEW` + `interrupted`，`pendingInput` 清掉。本轮验证结果未入 JSON。worktree 仍在。**结构 PROVEN；杀进程 UNPROVEN。**

**approve checkpoint**

顺序：`setState(FINALIZING)` persist → `checkpointCommit`（`git add -A` + commit）→ `setState(COMPLETED)` persist → `cleanupWorktree`。

- kill 在 FINALIZING 已落盘、commit 未完成：状态卡在 `FINALIZING`。`recoverInFlight` **不含** `FINALIZING`。`needsAttention` **不含** `FINALIZING`。`continue`/`approve` 都不接受该状态。**任务可从 Supervisor 视图消失。PROVEN（状态机 + hydrate 列表）。**
- kill 在 commit 成功、COMPLETED 未 persist：任务分支上可能已有 checkpoint，JSON 仍为 FINALIZING。同上卡住。checkpoint 是否完整 **UNPROVEN**。
- kill 在 COMPLETED persist 之后、拆 worktree 前：任务已完成；worktree 遗留。`doctor` 把终态占用的 worktree 当孤儿（`tests/doctor.test.ts`）。`prune` 可拆。**PROVEN（设计+测试）。**

**apply cherry-pick**

`cherryPickToRepo`：失败则 `cherry-pick --abort` 再抛错（`src/workspace/worktree.ts`）。成功后写 `appliedHead`，journal，然后 **dispatch persist**。

- kill 在 cherry-pick 进行中：可能留下 `cherry-picking` 中的当前分支。`--abort` 未跑。**UNPROVEN。**
- kill 在 HEAD 已前进、`tasks.json` 未写 `appliedHead`：git 已有新 commit；再 `apply` 因 `appliedHead` 空会再 cherry-pick，通常失败并 `--abort`。幂等只认「`appliedHead === 当前 HEAD`」。**结构 PROVEN；双 apply UNPROVEN。**

`tests/task-manager.test.ts` / `tests/mcp.test.ts` / `tests/cli.test.ts` 覆盖成功 apply，**不覆盖 kill。**

---

## 3. hydrate 恢复的是 Task state，不是 live Agent Session

hydrate（`src/core/task-manager.ts`，`f17b3f6`）清空内存 `sessions` / `permissionResolvers` / `turnEpoch`，从 JSON 拷 `TaskRecord`，再对 in-flight **改 Task 状态**。不重连 ACP stdio，不复活 pid。

`AcpRuntimeDriver.live` 仅在本进程（`src/runtime/acp/driver.ts`）。MCP 被杀后 live session **一定没了**。

Claude / DeepSeek Profile 均为 `bridge-owned`（`src/workers/profiles.ts`）。Windows 上 spawn 后进 Job Object `KILL_ON_JOB_CLOSE`（driver + `tests/job-object.test.ts`）。MCP 进程退出 → Worker 子进程应被杀。**Job Object 单元测试 PROVEN；MCP 被杀连带杀 Claude 的 live 观测 UNPROVEN。**

### MCP 被杀后的 Task 语义

| 被杀时 JSON 中的 state | hydrate 后 | live ACP | pendingInput / waiter |
|---|---|---|---|
| `RUNNING` | `AWAITING_REVIEW` + `interrupted`；`sessionId` 保留（若曾 persist） | 无 | 无 waiter。`respond` 不可用 |
| `WAITING_FOR_INPUT` | 同上；**清掉 `pendingInput`** | 无 | 无 live Promise。`respond` 抛「no live permission waiter」（`task-manager.ts`）。必须 `continue` |
| `VERIFYING` | 同上；本轮 `lastVerification` 可能未写入 | 无 | — |
| `AWAITING_REVIEW` | **不变**（非 in-flight） | 无 | — |
| `QUEUED` / `STARTING` | 收成 `AWAITING_REVIEW` + `interrupted` | 无 | — |
| `FINALIZING` | **不变**（缺口，见第 2 项） | 无 | — |

测试：`tests/permission.test.ts` hydrate in-flight；`tests/mcp.test.ts`「MCP hydrates leftover RUNNING」；`tests/task-manager.test.ts` hydrate 后 continue 把 **JSON 里的 `sessionId`** 传入 `driver.start({ resumeSessionId })`。

### continue 时 Agent Session 还能保留什么

`continue` → `startTurn` → 无内存 session 则 `driver.start(..., { resumeSessionId: task.sessionId })`。

**Claude（`loadSession: true`，adapter 声明 + Phase 0 / V0.5）：**

- 新 ACP 进程 `initialize` 后 `session/load` 旧 id。成功则 `resumed: true`，同一 `sessionId`（driver `loadSession` 分支）。
- 失败则 `session/new`，REHYDRATE：新 session + worktree 文件 + continue notes。旧对话 **不保证** 还在。
- MCP 被杀后原 Claude 子进程应已死；load 是 **cold load**，不是 reattach pid。V0.5：不 reattach 死 pid。
- 闸上的 permission Promise **不**随 load 回来。

**DeepSeek：** driver 仅在 `agentCapabilities.loadSession` 为真时 load。Harness **无 loadSession**（V0.5 / capability-matrix）。一律 `session/new` + REHYDRATE。保留：worktree 内容、`TaskRecord`（objective、notes、baseCommit、sessionId 字段可在 JSON 中但仍不能 load）。不保留：Harness 对话记忆。**PROVEN（能力矩阵 + driver 分支）；DeepSeek cold load 失败路径为本机 Phase 0，非本仓库 kill 测试。**

`expireWait` 会 `task.sessionId = undefined`（`26a9b04`）。`TASK_TIMED_OUT` 后再 continue **不会**带旧 session 去 load。

---

## 4. V1 并发模型（按现实现描述；加锁为规范缺口）

| 维度 | 现实现 | V1（路线 B 应写进产品说明） |
|---|---|---|
| 每数据目录的 MCP Core 进程 | 无限制 | **恰好 1 个写者**；第二进程 `CORE_LOCK_HELD` |
| 每进程每 project 的 Core | 1（`cores` Map） | 保持 1 |
| 并发 Task | 无上限；`tasks` Map | 允许 N 个 Task 记录；同时 `RUNNING` 的 ACP 子进程数 **未限流**（**UNPROVEN** 资源上限） |
| 多 Codex 窗口 | 无检测 | **禁止**两个窗口各带一个 MCP 写同一 project。应共用同一 MCP 进程，或第二窗口只读失败 |
| CLI | 独立进程，无锁 | 与 MCP 互斥；MCP 存活时 CLI 对同一 project fail-closed |

`clientRequestId` 幂等只在 **同一已加载的 Core 内存 + JSON** 内有效。双进程下两份 `run` 可各建一个 worktree。**UNPROVEN（无测试）。**

---

## 5. Session TTL / stall（现实现 vs V1 语义）

**现实现没有 Session TTL，没有 stall，没有 `suspected_stall`。**  
ACP `sessionUpdate` 为空函数（`src/runtime/acp/driver.ts`）。无 last-event 时间戳。

**已实现、不要与 stall 混淆的是 wait 预算 `timeoutMs`（默认 900000，`26a9b04`）：**

| | `timeoutMs`（已实现） | stall / TTL（未实现） |
|---|---|---|
| 触发 | Supervisor 的 `wait()`/`bridge_run` 轮询到期，且状态仍非 wait 返回态 | 无 |
| 状态 | `TASK_TIMED_OUT` + `interrupted`；`lastStopReason=wait_timeout` | — |
| 是否自动 cancel | **停 Worker**（`stopSession`：ACP cancel + close + 清 `sessionId`），**不是** `CANCELLED`。worktree 保留。可 `continue` 或 `reject` | — |
| 安静 ≠ turn 结束 | `wait` 只认状态机（`WAITING_FOR_INPUT` / 终态 / 审核 / `TASK_TIMED_OUT`），**不**因无 stdout 而 `AWAITING_REVIEW`。符合 V0.4「禁止因为安静判定 turn 结束」。**PROVEN（wait 循环 + fake `CANCEL_WAIT` 测试 `tests/timeout.test.ts`）。** | |

**V1 若补 stall（规范，非现码）：**

- 触发：live session 存在，且超过阈值未收到任何 ACP `session/update`（需先记录 update，今日未做）。
- 状态：保持 `RUNNING` 或增加 health=`suspected_stall`；**不得**自动变成 `AWAITING_REVIEW` 或 `COMPLETED`。
- 自动 cancel：**否**。Supervisor 选择 `continue` / `cancel` / 等到 `timeoutMs`。
- 与 `timeoutMs`：stall 是提示；`timeoutMs` 仍是 wait 硬截止并停 Worker。
- Session TTL：live ACP 空闲关闭 stdio，Task 仍为 `AWAITING_REVIEW` 或 `RUNNING` 按当时状态；关 session ≠ turn 结束。

---

## 6. 路线 B 的 V1 产品完成标准

下列均为 **完成定义**。括号内为现状。

| 项 | 做到才算完成 | 现状 |
|---|---|---|
| 安装 | 文档给出本机 Node 路径；一条清单或脚本能让 `bridge_doctor` 在目标机上 git/node/tsx/job-object 为 ok（Windows）。不要求单文件 EXE | 源码 + `npm install`。无 installer。**未完成** |
| MCP 注册 | `~/.codex/config.toml` 出现 `[mcp_servers.agent-bridge]`，command 为 `node.exe` + `--import tsx` + `server.ts`，cwd 为仓库，`NODE_PATH` 指向本仓库 `node_modules`。新开 Codex 会话 `tools/list` 含 `bridge_run`/`bridge_respond`/`bridge_apply`。`doctor` 的 `codex-mcp` ok | 作者机已配（`docs/CODEX_SKILL.md`）。无安装器写入 toml。**作者 PROVEN；陌生人 UNPROVEN** |
| Skill | `~/.codex/skills/agent-bridge/SKILL.md` 与仓库 `skills/agent-bridge/SKILL.md` 同步。闭环含 respond / timeout / hydrate 后 continue | 实现者手动 Copy。doctor **不检查** Skill 文件。**未完成自动化** |
| 凭证 | doctor 只报「存在/缺失」，不打印值。Claude：本机 Claude 凭证文件。DeepSeek：`DEEPSEEK_API_KEY` 或现有 loader。无则 `bridge_agents` 标不可用，**不**把密钥写入 journal（`tests/journal.test.ts` redact） | 检测已有（`src/core/doctor.ts`、`src/workers/credentials.ts`）。无引导 UI。Windows Credential Store **未做**。V1 不要求 Store，要求：缺密钥时 fail 清晰、不泄漏 |
| doctor | 现有 check 全绿或明确修复指令：git、node、tsx、job-object、mcp 段、可选 project 的 verify.json 与 orphan worktrees | **已实现**（`24af4d6` 等）。不覆盖 Skill、core.lock、多进程 |
| 卸载 | 文档：删 mcp 段、删用户 Skill 目录；可选删各仓库 `.agent-bridge-data`。不改用户 git config。不删任务分支除非用户 `prune` 策略允许 | **无卸载程序。UNPROVEN** |
| retention | 有书面策略并实现其一：`prune` 拆终态/孤儿 worktree（已有）；journal 按大小或天数截断或轮转；**默认不删** `agent-bridge/*` 任务分支 | prune **已实现**（`96c294e`）。journal 轮转 **未做**。长期堆积 **PROVEN 为缺口** |

V1 **不**把 HTTP daemon、SQLite、GUI、EXE 列入完成标准。

陌生人按文档独立装好并跑通 Claude approve+apply：**UNPROVEN**（仅作者机 2026-08-19 闭环）。

---

## 结论

**足以继续推迟 HTTP daemon 和 SQLite，条件是 V1 把「单写者」写成 fail-closed，而不是假设不会发生双进程。**

- 推迟 **HTTP daemon**：有证据。Codex 入口已是 MCP stdio；live Claude 闭环不依赖 loopback HTTP。第二套传输不能修第 1 项的锁问题，只是换地址。
- 推迟 **SQLite**：有证据到「单进程 + JSON 落盘 + hydrate」已支撑该闭环；换引擎不自动得到互斥或原子替换。`writeFileSync` 截断即空库、无跨进程锁、`FINALIZING` 不 hydrate——这些是 **文件协议缺口**，用 lockfile + temp-rename + 把 `FINALIZING` 纳入恢复就能在 JSON 上修，不必上 SQLite。
- 若拒绝做 lockfile、并允许两个 Codex 窗口默认同写：则 **不足以** 宣称当前持久化安全；那仍不迫使上 HTTP，但会迫使先做互斥，否则不能 Accept 路线 B 为可分发 V1。

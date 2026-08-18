# ADR-001: MVP 之后走 MCP 产品线，还是继续完成 V0.4 全量规划

## Status

Accepted

本修订（Worker 配置策略、`core.lock` stale-lock、Windows `.cmd` 表述）**不改变 Status，不重开路线 A/B**。

## Date

2026-08-19（Proposed 同日；Accepted 2026-08-19）

证据附录：`docs/decisions/ADR-001-appendix-route-b-evidence.md`

---

## Decision

**采纳路线 B — MCP stdio 为 V1 基线。**

当前问题是文件协议和生命周期恢复问题，不是缺 HTTP daemon 或 SQLite。已验证的 Codex MCP 闭环方向不被推翻。

- V1 内核 = 现有 MCP stdio Core + `tasks.json` / ndjson journal + worktree / verify / approve / apply
- **HTTP daemon、SQLite、GUI、单文件 EXE：推迟，不是取消。** 重新开启需要新证据并另写 ADR-002
- 可分发 V1 **必须**通过下方 Release Gates（P0 阻塞发布；P1 不阻塞本 ADR 接受）

OpenCode 及其他 Agent 后接，只加 Profile，不作为本 ADR 范围。

---

## V1 Release Gates

### P0（阻塞可分发 V1；不阻塞本 ADR 已 Accepted）

- [x] **跨进程单写者，fail-closed**  
  一个 `project/.agent-bridge-data` 同一时刻最多一个 Writer Core。`cores` Map 只覆盖本进程，不足。第二写者（另一 MCP 进程或 CLI）必须立即 `CORE_LOCK_HELD`：**不得 hydrate、不得写 `tasks.json`**。完成后路线 B 的「单 MCP Core 产品模型」才成立。  
  **stale-lock：** 持锁 pid 仍存活 → 不得接管。持锁进程已退出但 `core.lock` 仍在 → 新 Writer 可接管；接管前必须确认原 pid 已死。无法判定死活时 fail-closed（`CORE_LOCK_HELD`），`doctor` 标明占用或疑似 stale，禁止静默删锁后继续写。正常退出应释放锁；崩溃不得永久堵死该项目，也不得双写。
- [x] **`tasks.json` 原子持久化 + 损坏 fail-closed**  
  `write temp` → 完整写入成功 → atomic replace。`JSON.parse` 失败 **不得** 变成 `tasks: []`，必须 `TASK_STORE_CORRUPTED`（或等价）。不需要 SQLite。
- [x] **`FINALIZING` 确定性崩溃恢复**  
  hydrate / `needsAttention` 必须看见它。区分：checkpoint 未创建；checkpoint 已有但 COMPLETED 未持久化；COMPLETED 已持久化但 worktree 未拆。确定性恢复，不猜测。不需要 HTTP/SQLite。

### P1（不阻塞 ADR 接受；发布前应做）

- [x] `apply` 中途崩溃 / 幂等故障注入（cherry-pick 成功但 `appliedHead` 未 persist；kill 留下 cherry-picking 状态）。apply 改用户当前仓库，对外发布前必须测。属路线 B 可靠性，不是改走 HTTP/SQLite 的理由
- [x] 同 Task 并发命令测试：`approve`+`continue`、`respond`+`cancel`、两个 `apply`。非法竞争须 `STATE_VERSION_CONFLICT`，禁止先产生副作用再报错。两个 `apply` 同改用户 repo 为重点
- [x] journal / 数据 retention
- [x] 安装、MCP 注册引导、Skill 安装、凭证引导、doctor 补全、卸载说明。完成标准：用户至少已有一个可独立正常运行、完成认证和配置的 Worker；Bridge 负责检测，不负责配置 Worker 模型或第三方 Provider。MCP `command` 用 `node.exe` + tsx，不要用 `npx.cmd` / `tsx.cmd`（Node 直接 spawn `.cmd` 会 EINVAL；这不是禁止一切 `.cmd` shim）
- [ ] 干净 Windows / 陌生用户：从安装说明开始，不改 Bridge 源码，完成一次 Claude `run → permission → verify → approve → apply`（README / `scripts/install.ts` 已就绪；live 需按文档在目标机跑）
- [x] **Worker Configuration Inheritance Test：** 分别验证 Claude Code 与 DeepSeek Harness 经 Bridge 新启动的 Session 继承用户已有持久 model / effort 配置。某 Worker 不继承时只做该 Worker 最小兼容，不建立统一模型管理系统

同进程多 `tools/call` 重叠（`rl.on("line", async ...)` 无队列）**不**升为 ADR 阻塞。不同 Task 允许并行；同 Task 靠 `stateVersion`。尚无实际 race 失败证据。P1 并发测试覆盖即可。

### 明确推迟（需新证据才开 ADR-002）

不是取消：HTTP daemon、SQLite、GUI、single-file EXE。

可触发 ADR-002 的例：多个 Codex 窗口必须共享同一个 live Worker Core；跨 Codex 会话必须保持 Agent 实时运行；JSON 单写者出现实测性能/可靠性瓶颈；必须有独立桌面端管理大量并发任务。

### 明确推迟（不塞进 V1，不另开 ADR-002）

按 Task 覆盖 model / effort、Execution Profile、Provider 管理。V1 只选 Worker，继承用户原生持久配置。Claude 的 upstream provider 是 Worker 内部实现。

---

## Stall / TTL（已定，不再讨论）

现机制只有 `timeoutMs` → `TASK_TIMED_OUT` → 停 Worker、保留 worktree、可 continue/reject。安静 ≠ turn 结束。

未来 stall：无事件 → `health = suspected_stall`。禁止无事件 → 自动完成。禁止默认自动 cancel。

---

## 1. 产品不变约束

这些是已冻结、且已被实现与实测咬住的硬约束：

| 约束 | 含义 |
|---|---|
| Codex = 唯一 Supervisor | 计划、审核、approve / continue / reject |
| Worker = 外部完整 Coding Agent | 当前只稳定 Claude Code 与 DeepSeek Harness |
| Bridge 不调用 LLM | 无编排模型、无自动批准 |
| Diff | `baseCommit` vs 当前 worktree，禁止把 `base..HEAD` 当变更来源 |
| Verification | 只跑 `.agent-bridge/verify.json` 的 verifyId |
| Worker 不得 commit / push / merge / rebase | approve 只在任务分支打 checkpoint |
| apply | cherry-pick，不是 merge |
| Turn 结束 ≠ 任务完成 | 只有 Supervisor approve 后才 COMPLETED |
| OpenCode | 本 ADR **不要求现在接入**；后续慢慢加 Profile |
| V1 只选 Worker | 不选择/管理 model、provider、reasoning effort、model routing；不猜测 effective upstream model。Claude 走官方 Anthropic / CC Switch / 其他第三方 Provider 均为 Worker 内部实现 |

---

## 2. 原文档规划了什么

### 2.1 V0.4 / 路线图的「全套」

`IMPLEMENTATION_ROADMAP.md`：

```text
Phase 0  验证未知
Phase 1  最小闭环
Phase 2  可靠性
Phase 3  Codex正式接入
Phase 4  Claude/OpenCode
Phase 5  产品化（installer / PATH / setup / 凭证 / WebView2 / update）
```

V0.4 还写死过：

- Core 传输：**127.0.0.1 loopback HTTP + admission credential**
- 持久化：**SQLite**
- GUI：最后做，**WebView2 + loopback**，只展示任务/日志/权限，不是协议
- 单文件 EXE：产品目标（Bun compile / Node SEA），不是架构前提
- Session TTL、stall、retention、Windows Credential Store、interactive question

### 2.2 V0.5 已经改过一次「不要现在做」

V0.5（2026-08-18）在 Phase 0 实测后冻结：

- Codex 入口：**MCP 优先，CLI 永久保留**
- Worker：只稳定 DeepSeek + Claude；**OpenCode DEFERRED**
- 明确仍不做：OpenCode Profile、GUI、完整 SQLite / HTTP Core daemon

也就是说：**原「全套」在 V0.5 就已经不再等于当前冻结基线。** 审核时要分清「V0.4 愿望清单」和「V0.5 冻结范围」。

---

## 3. 现在实际完成了什么

实现以 `src/` 为准，不是以 V0.4 愿望清单为准。

### 3.1 已落地的内核

| 能力 | 状态 | 证据 |
|---|---|---|
| 状态机 + worktree + ReviewPacket + verify allowlist | 已实现 | Phase 1；`npm test` |
| Replay / ACP Runtime + Worker Profile | 已实现 | fake ACP、Claude、DeepSeek |
| CLI 与 MCP 共用 `src/api/client.ts` | 已实现 | `src/cli.ts`、`src/mcp/server.ts` |
| Codex Skill | 已实现 | `skills/agent-bridge/SKILL.md` 及用户级副本 |
| doctor / agents / version / prune | 已实现 | `24af4d6`、`96c294e` |
| journal 脱敏 | 已实现 | `24af4d6` |
| Claude `session/load`；DeepSeek REHYDRATE | 已实现 | `24af4d6` |
| MCP 进程内 Core 单例 | 已实现 | live ACP session 跨 `bridge_*` |
| permission 闸 `WAITING_FOR_INPUT` + `bridge_respond` | 已实现 | `0f730d6` |
| wait 预算到期 → `TASK_TIMED_OUT`，可 continue | 已实现 | `26a9b04` |
| hydrate 收 in-flight + `tasks.json` 即时落盘 | 已实现 | `f17b3f6` |
| approve 拆 worktree；apply cherry-pick | 已实现 | `e1a1afc` |

自动化测试：`npm test` **33 项全绿**（2026-08-19，hydrate 提交时）。

### 3.2 已在本机 Codex 上实测的闭环（不是纸面）

测试仓库：`C:\Users\jjbon\Downloads\测试`

1. **permission 闸（fake + Claude）**  
   `WAITING_FOR_INPUT` → `bridge_respond`（Claude 的 optionId 为 `allow`，kind=`allow_once`）→ `AWAITING_REVIEW`。未把 `end_turn` 当成完成。

2. **完整 Supervisor 闭环（Claude，2026-08-19）**  
   - `WAITING_FOR_INPUT`（写 `src.ts`，respond `allow`）  
   - `AWAITING_REVIEW`，仅修改 `src.ts`，`verification.passed: true`  
   - `bridge_approve` → `COMPLETED`，`approvedCommit=00cb80c466b694bef086b30679d1670d434efe93`  
   - `bridge_apply` cherry-pick 到当前分支，`head=8c54f4bb9bbf5f340960e7e753d5d4c374059a49`  
   - 仓库核对：`master` 上 `src.ts` 为 `export const v = 2`；无 push、无 merge  

这证明：**Codex 经 MCP 监督 Claude，完成「闸 → 验证 → 批准 → 落到当前分支」。** Bridge 没有自己改那个仓库。

### 3.3 已知缺口（实现层，不是愿望）

| 缺口 | 现状 | 影响 |
|---|---|---|
| 安装 | 手配 Node、`codex mcp add`、拷 Skill | 别人不能开箱即用 |
| 凭证 | DeepSeek 读环境/文件；Claude 用本机 Claude 凭证；无 Windows Credential Store | 能跑，但不像产品 |
| stall / Session TTL | 只有 `timeoutMs` 硬截止 |  Worker 无事件挂住时只能等预算 |
| retention | journal / 任务分支 / 数据目录会堆积 | 长期使用脏 |
| interactive question | 只闸 ACP `requestPermission` | 尚未见到非 permission 提问挡住闭环 |
| HTTP + SQLite | 未做；Core 在 MCP 进程内，状态在 `.agent-bridge-data/tasks.json` + ndjson journal | Codex 关会话会杀 MCP 进程；hydrate 把 in-flight 收成待审查 |
| GUI | 未做 | Supervisor 已在 Codex 聊天里审核 |
| 单文件 EXE | 未做；Node + tsx 跑源码 | 分发摩擦 |
| DeepSeek 在 Windows 跑项目测试 | Worker bash/`E_ACCESSDENIED` | 验收必须走 Bridge verify.json，不能信 Worker |
| OpenCode | DEFERRED | 本 ADR 范围外 |

---

## 4. 两条候选路线

### 路线 A — 继续完成原文档全套（V0.4 + 路线图 Phase 2 余项 + Phase 5）

做完：

1. loopback HTTP Core daemon + admission credential  
2. SQLite 替换或并列于 `tasks.json`  
3. Session TTL、无事件 stall、retention  
4. interactive question 全文闸  
5. Windows Credential Store  
6. installer / PATH / setup / 更新  
7. WebView2 GUI  
8. 单文件 EXE（Bun 或 Node SEA）  

OpenCode 仍可后做。

**理由（原文档）：** Core 应独立于 Codex 进程存活；HTTP 是 V0.4 的传输决定（D6）；GUI 给人看队列；SQLite 是「真持久化」。

**代价：** HTTP daemon 与当前 MCP stdio Core **叠第二套传输**。GUI 与 Codex 审核面重叠。工程量大约相当于再做一个与现内核同量级的产品表面。V0.5 已把 GUI 和 HTTP/SQLite 标成暂不做。

### 路线 B — 以已验证的 MCP stdio 为产品基线（本 ADR 提案）

**现在的实现就是 V1 内核。** 下一步只补「别人能装、能用、能清」：

优先（建议按序）：

1. 安装引导：注册 Codex MCP、安装 Skill、doctor 一键检查  
2. 凭证引导（仍不把密钥写入 journal）  
3. journal / worktree / 任务数据 retention  
4. stall 或 Session TTL（在 `timeoutMs` 之上增加「无事件过久」标记，不要靠安静推断 turn 结束）  
5. 更新通道（可选，可很薄）  

明确推迟，直到有新证据：

- loopback HTTP + SQLite（仅当「MCP 进程被杀导致无法接受的丢失」被实测证明；hydrate 已覆盖 in-flight → 待审查）  
- WebView2 GUI（仅当必须离开 Codex 看多任务队列）  
- 单文件 EXE（安装脚本能用之后再考虑）  
- interactive question（仅当真实 Worker 用非 permission 提问挡住任务）  
- OpenCode 及其他 Agent（按用户意见后接，只加 Profile）  

**理由：** 独特价值（Supervisor/Worker 分离、worktree、独立验证、approve/apply）已经在 Claude 真闭环上成立。MCP 优先是 V0.5 冻结结论，不是权宜之计。再按 V0.4 造常驻 HTTP Core，是在已验证入口旁边再造一层。

**代价：** MCP 随 Codex 会话生死；多会话/多客户端同写一个 Core 不是当前模型。长期磁盘堆积若没有 retention 会变脏。

---

## 5. 关键判断（供同意或反驳）

1. **V0.4 的 HTTP Core 是在「Codex 怎么进」未知时写的。** 实测后入口是 MCP stdio。V0.5 已写「MCP 优先」。把 HTTP daemon 当未完成的必做项，等于忽略这次实测。  
2. **GUI 文档自己规定「不是协议、最后做」。** Codex 已经承担审核 UI。先做 WebView2 不会增加 Worker 闭环能力。  
3. **SQLite 能解决的问题，`tasks.json` 即时落盘 + hydrate 已经覆盖了当前单机、单 MCP 进程模型。** 换引擎要有并发或损坏方面的新证据。  
4. **「别人能用」卡在安装与引导，不卡在缺 GUI 或缺 HTTP。**  
5. **Interactive question / stall / retention 属于补产品，不是再选架构。** 路线 B 并不否认它们。

若审核者主张路线 A，请指出：哪一条已完成闭环在没有 HTTP/SQLite/GUI 时是假完成，或哪一个具体失败模式是 hydrate + `timeoutMs` 消不掉的。

---

## 6. 裁决记录（历史）

2026-08-19 正式采纳路线 B。原「请审核者三选一」已关闭。证据见附录。不在此重开 A/B。

---

## Alternatives Considered

### 路线 A — 完成 V0.4 HTTP/SQLite/GUI/EXE 全套

Rejected。附录表明缺口是文件协议与 `FINALIZING` 恢复，不是缺第二套传输或数据库引擎。

### 停在当前仓库，不写安装器

Rejected as 可分发 V1。作者机闭环 ≠ 产品。安装与 P0 文件协议仍要做。

### 先做 HTTP+SQLite，安装器后做

Rejected as 默认顺序。与 MCP 入口叠 Core；用户仍装不上。

### 现在就接 OpenCode

Deferred。后接 Profile。与本路线正交。

## Consequences

- 下一阶段实现顺序：P0 三门（锁、原子 JSON、FINALIZING 恢复）→ P1 可靠性与安装验收。不实现 HTTP/SQLite/GUI/EXE，除非 ADR-002
- V0.4 保留为架构思想，不再当 sprint backlog
- KPI：干净机器上 Claude `run→permission→verify→approve→apply`，而不是 daemon 监听 127.0.0.1
- 本 ADR 仅被 ADR-002 在新证据下 supersede

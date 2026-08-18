# ADR-001: MVP 之后走 MCP 产品线，还是继续完成 V0.4 全量规划

## Status

Proposed（待审核，尚未采纳）

## Date

2026-08-19

## 本文用途

给外部审核者（含 GPT）一份**可独立阅读**的材料，在两条路线里选一条，或提出有证据的第三条。

不要根据这份文档改代码。先做路线裁决。

仓库：`C:\Users\jjbon\Documents\Codex\Agent Relay`  
当前版本：`0.5.0`（`package.json`）  
基线文档：`docs/Agent_Bridge_Technical_Design_V0.5.md`  
架构原稿：`docs/Agent_Bridge_Technical_Design_V0.4.md`  
路线图：`docs/IMPLEMENTATION_ROADMAP.md`

---

## 1. 产品不变约束（审核时不得推翻）

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

## 6. 请裁决

请只选一个，并写理由（3–8 条，引用本文证据或指出本文缺证）：

- **采纳路线 B**（MCP 产品线；HTTP/SQLite/GUI/EXE 等证据再开）  
- **采纳路线 A**（按 V0.4 全套做完，OpenCode 除外）  
- **第三条**：写清范围、顺序、以及它如何处理 MCP 已存在这一事实  

无论选哪条，保持第 1 节硬约束。不要建议 Bridge 调用 LLM，不要建议 merge 代替 cherry-pick，不要建议信任 Worker 自称测过。

---

## Alternatives Considered

### 停在当前仓库，不写安装器

- 优点：零额外工作  
- 缺点：只有作者机器能用，不能称为产品  
- 不作为本 ADR 的「完善产品」选项  

### 先做 HTTP+SQLite，安装器后做

- 优点：接近 V0.4 D6  
- 缺点：用户仍然装不上；且与 MCP 单例双重 Core  
- 拒绝作为默认顺序  

### 现在就接 OpenCode

- 用户已指示后续慢慢接入  
- 与本路线选择正交，不阻塞 A/B  

## Consequences（若采纳 B）

- V0.5「仍不做 HTTP/SQLite/GUI」从暂缓变为**产品方向**，直到出现新证据  
- 下一阶段 KPI 是：陌生人按文档能注册 MCP 并跑通一次 approve/apply，而不是 daemon 监听 127.0.0.1  
- V0.4 仍保留为架构思想来源，不再当 sprint backlog  
- 若日后 MCP 进程模型破产，再写 ADR-002 启用 HTTP Core，并标明本 ADR 被 supersede  

## Consequences（若采纳 A）

- 需要重新打开 V0.5 第 5 节「明确仍不做」  
- 工期与范围按「第二个产品表面」估计，而不是「扫尾 Phase 2」  
- MCP stdio 仍应保留（V0.5：CLI 永久保留；MCP 已是 Codex 入口），HTTP 只能是附加，不能拆掉已验证入口  

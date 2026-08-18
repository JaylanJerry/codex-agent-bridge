# Agent Bridge 技术开发设计文档 V0.4

**状态：** Final Architecture Baseline / Phase 0实测后冻结实现接口  
**平台：** Windows x64优先  
**源码语言：** TypeScript，使用Node-compatible API  
**Worker协议策略：** ACP-first，Native fallback，PTY last resort  
**第一个Worker：** DeepSeek Harness  
**Supervisor：** Codex / GPT-5.6 Sol

---

# 0. V0.4核心决策

| ID | 决策 | 结论 |
|---|---|---|
| D1 | 主项目基础 | 新建干净仓库，不fork现有orchestrator |
| D2 | Worker通信 | ACP-first，使用官方`@agentclientprotocol/sdk` |
| D3 | Agent接入抽象 | Protocol-first：Runtime Driver + Worker Profile |
| D4 | DeepSeek | 首先验证`dsh-acp`，失败再尝试Harness Native SDK |
| D5 | Codex入口 | 最终MCP优先，CLI永久保留；Phase 0做A/B实测 |
| D6 | Core传输 | loopback HTTP + admission credential |
| D7 | Workspace | 写任务默认独立git worktree |
| D8 | Worker Git | Worker不得commit/push/merge/rebase |
| D9 | 审核 | Worker turn结束≠任务完成；Codex显式approve/continue/reject |
| D10 | 验证 | Bridge独立Verification Runner，命令来自人类allowlist |
| D11 | Diff | 比较base commit与当前worktree，不能使用`base..HEAD`假设Worker已commit |
| D12 | 完成快照 | approve后Bridge可在任务分支创建确定性checkpoint commit；不自动合并主分支 |
| D13 | 进程所有权 | Runtime显式声明bridge-owned / external-owned / shared-service |
| D14 | Core智能 | Bridge绝不调用LLM |
| D15 | 打包 | 不提前锁死Bun；Node-compatible优先，Phase 1做packaging spike |
| D16 | 类似项目 | 作为参考/选择性复用，不作为基础fork |

---

# 1. 项目定位

Agent Bridge是：

> **Codex与外部完整Coding Agent之间的本地任务执行、生命周期、验证和审核桥。**

它不是“把第三方模型塞进Codex”。

```text
第三方模型Subagent
=
第三方模型
+
Codex自己的Harness/Tools/Sandbox
```

Agent Bridge则是：

```text
Codex Supervisor
        ↓
完整外部Agent
        ↓
外部Agent自己的Harness/Tools/Session/Agent Loop
```

只有第二种需求才使用Agent Bridge。

---

# 2. 产品成功标准

```text
用户提出需求
↓
Codex规划
↓
Bridge委派
↓
Worker执行
↓
Bridge独立验证
↓
Codex审核
↓
不通过 → 原任务返工
↓
再次验证
↓
Codex通过
↓
形成已批准任务快照
```

用户全程不需要复制Prompt、日志或审核意见。

---

# 3. 总体架构

```text
┌─────────────────────────────────────┐
│               USER                  │
└──────────────────┬──────────────────┘
                   │
                   ▼
┌─────────────────────────────────────┐
│         Codex / GPT-5.6 Sol         │
│ Planner / Architect / Reviewer      │
└──────────────────┬──────────────────┘
                   │
          MCP primary / CLI fallback
                   │
                   ▼
┌─────────────────────────────────────┐
│           Agent Bridge Core         │
│                                     │
│ Task Manager                        │
│ State/Verdict Manager               │
│ Scheduler                           │
│ Workspace/Worktree Manager          │
│ Verification Runner                 │
│ ReviewPacket Builder                │
│ Continuation Manager                │
│ Runtime Router                      │
│ Process Manager                     │
│ Event Journal / Replay              │
│ Persistence / Logs                  │
│ Credential / Permission Policy      │
└──────────────────┬──────────────────┘
                   │
             Runtime Router
                   │
       ┌───────────┼─────────────┐
       │           │             │
       ▼           ▼             ▼
  ACP Runtime   Native Runtime  PTY Runtime
   DEFAULT        FALLBACK       LAST RESORT
       │
  ┌────┼─────────┐
  ▼    ▼         ▼
 DSH Claude   OpenCode
```

---

# 4. ACP-first

ACP已经提供标准Coding Agent通信层。

当前公开生态已有：

- 官方TypeScript SDK；
- OpenCode原生`opencode acp`；
- Claude Agent ACP适配器；
- DeepSeek Harness`@deepseek-ai/dsh-acp`与automation example。

Bridge不应该重新为每个Agent实现一套：

```text
spawn framing
session lifecycle
permission
cancel
stream event
```

共同部分由ACP Runtime处理。

---

# 5. ACP-first不等于ACP-only

DeepSeek Harness当前ACP automation surface有意保持窄能力，不承担完整UI或所有人机交互能力。

因此：

```text
ACP能力足够
↓
ACP Runtime

ACP缺关键能力
↓
Native Runtime

两者都没有
↓
PTY/TUI Fallback
```

原则：

> **Protocol capability决定实现，而不是Agent名字决定实现。**

---

# 6. Runtime Driver与Worker Profile

```ts
type RuntimeKind = "acp" | "native" | "pty";

type RuntimeOwnership =
  | "bridge-owned"
  | "external-owned"
  | "shared-service";

interface WorkerProfile {
  id: string;
  displayName: string;

  preferredRuntime: RuntimeKind;
  fallbackRuntimes: RuntimeKind[];

  launch?: {
    command: string;
    args: string[];
  };

  ownership: RuntimeOwnership;
  capabilityOverrides?: Partial<WorkerCapabilities>;
}
```

Runtime：

```ts
interface RuntimeDriver {
  readonly kind: RuntimeKind;

  probe(profile: WorkerProfile): Promise<CapabilitySnapshot>;

  start(
    profile: WorkerProfile,
    ctx: RuntimeContext
  ): Promise<RuntimeSession>;

  sendTurn(
    session: RuntimeSession,
    input: TurnInput
  ): Promise<void>;

  respond(
    session: RuntimeSession,
    answer: AgentAnswer
  ): Promise<void>;

  cancel(session: RuntimeSession): Promise<CancelResult>;

  subscribe(
    session: RuntimeSession,
    handler: RuntimeEventHandler
  ): Promise<Unsubscribe>;

  close(session: RuntimeSession): Promise<void>;
}
```

V1首先实现：

```text
AcpRuntimeDriver
ReplayRuntimeDriver
```

只有ACP实测缺关键能力时才增加Native Runtime。

---

# 7. Runtime Ownership

### bridge-owned

Bridge自己spawn：

- 可以加入Job Object；
- Core退出可清理；
- cancel可终止进程树。

### external-owned

用户预先运行。

Bridge只能连接，不能杀。

### shared-service

一个服务承载多个Session。

单任务cancel不能杀整个服务。

任何破坏性Process操作前必须检查ownership。

---

# 8. Codex入口

最终提供：

## MCP

作为Codex默认入口目标：

- 结构化参数；
- 结构化Result；
- 避免PowerShell quoting；
- 更自然的tool调用；
- 可暴露progress notification。

## CLI

永久保留：

```text
run
status
wait
tasks
review-packet
diff
approve
continue
reject
respond
cancel
logs
doctor
agents
version
```

MCP和CLI必须共用同一Core Client。

---

# 9. Core传输

采用：

```text
127.0.0.1 loopback HTTP
+
随机admission credential
```

Core只监听loopback。

endpoint记录：

```text
port
instanceId
protocolVersion
pid
processStartTime
```

所有破坏性操作必须核对instance identity。

Credential不写日志、不输出stdout。

具体Windows Credential Store实现由Phase 1 packaging spike选择。

---

# 10. Task Contract

```ts
interface BridgeTask {
  schemaVersion: "1.2";
  clientRequestId: string;

  objective: string;
  context?: string;
  projectPath: string;

  isolation?: {
    mode: "worktree" | "in-place";
    baseRef?: string;
  };

  constraints: string[];

  acceptanceCriteria: {
    id: string;
    text: string;
    verifiedBy?: string[];
  }[];

  allowedPaths?: string[];
  forbiddenPaths?: string[];

  verification?: {
    enabled: boolean;
    verifyIds: string[];
  };

  permissions?: PermissionPolicy;

  limits?: {
    maxDurationMs?: number;
    maxTurnDurationMs?: number;
    maxWorkerTurns?: number;
    maxReviewCycles?: number;
    maxCostUsd?: number;
    maxTokens?: number;
  };
}
```

`run`必须同步完成Schema、Agent、Capability、Path、Worktree和verify allowlist校验。

---

# 11. State / Event / Verdict / Health

## State

```text
QUEUED
STARTING
RUNNING
WAITING_FOR_APPROVAL
WAITING_FOR_INPUT
VERIFYING
AWAITING_REVIEW
FINALIZING
COMPLETED
FAILED
CANCELLED
TASK_TIMED_OUT
```

## Event

```text
runtime-started
session-created
agent-message
tool-start
tool-result
permission-request
interactive-question
worker-turn-finished
verification-start
verification-result
process-exit
state-changed
```

## Verdict

```text
APPROVED
NEEDS_REVISION
REJECTED
```

## Health

```text
ok
reconnecting
suspected_stall
degraded
```

---

# 12. 幂等和并发

`run`必须带：

```text
clientRequestId
```

重复：

- 内容相同 → 返回同taskId；
- 内容不同 → `TASK_ALREADY_EXISTS`。

破坏性命令必须带：

```text
expectedStateVersion
```

不匹配：

```text
STATE_VERSION_CONFLICT
```

禁止“尽量执行”。

---

# 13. Worker Turn结束不等于Task结束

优先级：

```text
protocol turn-end
↓
owned process exit
↓
turn timeout
↓
inferred + warning
```

禁止因为“安静了一段时间”判定turn结束。

```text
RUNNING
↓
worker-turn-finished
↓
VERIFYING
↓
AWAITING_REVIEW
```

只有Codex的：

```text
approve
continue
reject
```

才决定任务命运。

---

# 14. Continuation

```text
LIVE_SESSION
↓
NATIVE_RESUME
↓
REHYDRATE
↓
UNRECOVERABLE
```

Handoff Package包含：

- 原Task；
- 上一轮Worker最终消息原文截取；
- Codex review notes；
- 当前ChangeSet；
- Verification；
- open questions。

禁止默认重放完整Trajectory。

---

# 15. Worktree

每个写任务：

```text
baseCommit
↓
git worktree
↓
agent-bridge/<taskId>
↓
Worker
```

Worker与Verification Runner均在任务worktree执行。

`in-place`只做兼容逃生阀，且要求启动时工作区干净。

---

# 16. 修正V0.3的Git Diff问题

Worker默认不能commit。

所以：

```bash
git diff <baseCommit>..HEAD
```

不能作为审核数据源，因为HEAD可能仍等于baseCommit。

Change Collector必须比较：

```text
baseCommit
vs
当前worktree
```

要求：

1. Git porcelain枚举added/modified/deleted/renamed/untracked；
2. tracked diff使用`git diff <baseCommit> --`；
3. staged和unstaged都收集；
4. untracked单独处理；
5. 文本untracked可在预算内生成确定性new-file patch；
6. binary/大文件记录metadata/hash/size；
7. ChangedFile不得依赖HEAD移动。

---

# 17. ChangedFile

```ts
interface ChangedFile {
  path: string;
  change: "added" | "modified" | "deleted" | "renamed";
  oldPath?: string;

  tracked: boolean;
  staged: boolean;

  linesAdded?: number;
  linesRemoved?: number;

  isBinary: boolean;
  sizeBytes?: number;
  contentHash?: string;

  outOfBounds: boolean;
}
```

---

# 18. ReviewPacket

一次给Codex足够但受预算限制的审核材料：

- objective；
- acceptance criteria；
- verification evidence；
- Worker最终消息原文截取；
- diffstat；
- changed files；
- selected hunks；
- policy violations；
- open questions；
- warnings。

selected hunks确定性排序：

```text
越界
>
与验证/验收关联文件
>
最大改动
>
新增文件
>
其余路径排序
```

Bridge不使用LLM判断重要性。

---

# 19. Verification Runner

验证命令只来自：

```text
.agent-bridge/verify.json
```

Task只能引用verifyId。

禁止模型直接提供shell command字符串。

示例：

```json
{
  "schemaVersion": "1.0",
  "commands": {
    "test": {
      "exe": "npm",
      "args": ["test"],
      "timeoutMs": 900000
    }
  }
}
```

Windows遇到可信`.cmd/.bat` shim时，可以走Bridge唯一受控的`cmd.exe`封装，但参数必须来自已校验argv结构，不接受自由shell字符串。

验证失败：

```text
passed=false
```

Task仍进入`AWAITING_REVIEW`。

---

# 20. Approve后的稳定快照

Worktree隔离带来一个V0.3没有彻底解决的问题：

> Worker不commit时，审核通过后的代码不能只留在未提交worktree里。

V1定义：

```text
AWAITING_REVIEW
↓
approve
↓
FINALIZING
↓
Bridge在任务分支创建checkpoint commit
↓
COMPLETED
```

这个commit：

- 只在任务分支；
- 只在Codex明确approve后；
- commit message确定性生成；
- 不push；
- 不merge；
- 不rebase；
- 不修改用户当前分支。

Result返回：

```text
approvedCommit
taskBranch
baseCommit
```

随后Codex可以在自己的沙箱中：

```text
git cherry-pick approvedCommit
```

或由用户决定集成方式。

Bridge V1不自动改用户主分支。

---

# 21. 权限

```text
READ
WORKSPACE_WRITE
COMMAND_EXECUTION
NETWORK
SYSTEM_WRITE
GIT_READ
GIT_COMMIT
GIT_PUSH
ADMIN
```

Worker默认：

```text
READ allow
WORKSPACE_WRITE allow
GIT_READ allow
GIT_COMMIT deny
GIT_PUSH deny
SYSTEM_WRITE deny
ADMIN deny
```

必须区分：

```text
requested
enforcement
guarantee
```

不能把audit-only显示成“强制禁止”。

---

# 22. 安全边界

必须公开承认：

> Worker运行在Codex沙箱之外。

Bridge只能通过以下方式降低风险：

- worktree；
- path allowlist审计；
- verify allowlist；
- 最小env；
- Worker禁止Git历史写操作；
- Credential隔离；
- 进程树控制。

不得宣称可以防御恶意本地代码。

---

# 23. Process Manager

`bridge-owned`：

- windowsHide；
- stdio pipe；
- detached=false；
- Job Object；
- protocol cancel → graceful → hard kill。

`external-owned/shared-service`：

- 不误杀外部服务；
- cancel只针对Session；
- Bridge关闭只detach。

---

# 24. Core崩溃

对bridge-owned Worker：

```text
Core死
↓
Job Object收割Worker
```

重启后：

- 保留worktree；
- 保留journal/logs；
- 非终态任务检查代码；
- 能验证则执行验证；
- 转`AWAITING_REVIEW`；
- 标`interrupted=true`。

不假装重新attach已死亡进程。

---

# 25. Recorder / Replay

Runtime事件记录：

```text
events.ndjson
```

包含：

```text
seq
epoch
timestamp
runtime
event
payload(redacted)
```

`ReplayRuntimeDriver`必须与ACP Runtime通过同一套契约测试。

---

# 26. Persistence

事实来源：

```text
append-only journal / events
```

SQLite保存：

- Task索引；
- state；
- verdict；
- session mapping；
- verification；
- usage；
- capability snapshot。

写入顺序：

```text
记录intent
↓
执行副作用
↓
记录result
```

---

# 27. Codex掉线

Core不能依赖Codex在线。

恢复入口：

```text
tasks --needs-attention
```

或MCP等效查询。

至少找回：

- AWAITING_REVIEW；
- WAITING_FOR_APPROVAL；
- WAITING_FOR_INPUT；
- interrupted；
- limit exceeded。

---

# 28. MCP工具

建议：

```text
bridge_run_task
bridge_wait_task
bridge_list_tasks
bridge_get_review_packet
bridge_get_diff
bridge_approve
bridge_continue
bridge_reject
bridge_respond
bridge_cancel
bridge_logs
bridge_agents
bridge_doctor
```

全部返回稳定schema。

---

# 29. Capability Probe

每个Worker首次配置和版本变化后Probe：

```text
protocol handshake
session create
structured turn end
live continuation
cold resume
cancel
permission
interactive question
progress
usage
requires TTY
crash behavior
version
```

结果持久化。

---

# 30. DeepSeek Harness

第一路径：

```text
@deepseek-ai/dsh-acp
```

当前官方定位就是面向parent agents / subagent providers / programmatic clients的automation ACP server。

Phase 0必须实测：

- launch；
- protocol version；
- session；
- second turn；
- cancel；
- permission；
- turn end；
- output；
- crash；
- usage；
- TTY。

已知：

- ACP surface刻意不承担全部UI能力；
- interactive question不能默认假设；
- Harness处于Developer Preview，存在breaking changes。

ACP不够时：

```text
DeepSeekNativeRuntimeDriver
```

研究Harness TypeScript SDK / JSON-RPC runtime。

---

# 31. Claude Code

优先：

```text
claude-agent-acp
```

不先自己解析Claude CLI stdout。

只有ACP缺失关键能力时，才使用Claude Agent SDK Native Runtime。

---

# 32. OpenCode

优先：

```text
opencode acp
```

V1不优先走`opencode serve`。

以后只有shared-service或多路复用确有价值时再考虑Server模式。

---

# 33. PTY Fallback

只用于完全无结构化接口的Agent。

可参考Coder AgentAPI。

但它依赖terminal emulation和输出解析，V1不做。

---

# 34. 打包

源码目标：

```text
TypeScript
Node-compatible APIs
```

Phase 1做Packaging Spike：

- ACP SDK；
- SQLite；
- Credential Store；
- Job Object；
- ConPTY（若需要）。

候选：

```text
Bun compile
Node SEA
bootstrapper + runtime
```

单文件EXE是产品目标，不是架构前提。

---

# 35. GUI

最后做。

优先：

```text
WebView2 + loopback
```

GUI只展示：

- Agents；
- Running；
- Queue；
- History；
- Logs；
- Permissions；
- Diagnostics。

GUI不是Agent通信协议。

---

# 36. 测试

## L1 Unit
Schema、状态机、幂等、stateVersion、ChangeCollector、ReviewPacket、Verification、Redaction、Path。

## L2 Runtime Contract
ACP Runtime与Replay Runtime统一契约。

## L3 Replay
malformed、乱序、重复、crash、permission、late event、timeout。

## L4 Real Agent
固定fixture repo，完整两轮返工+approve+checkpoint。

## L5 Windows
中文路径、空格、长路径、OneDrive、无窗口、进程树、worktree、credential。

---

# 37. Phase 0 Go/No-go

Phase 0不写完整Core。

产物：

```text
docs/capability-matrix.md
docs/phase0-findings.md
```

Go条件：

1. 至少一个Worker可通过结构化Runtime驱动；
2. DeepSeek ACP或Native完成两轮任务；
3. turn end可靠；
4. cancel可用；
5. Codex可稳定通过CLI或MCP控制probe；
6. worktree/verify/Windows行为可接受；
7. packaging至少一个方案可行。

DeepSeek失败：

```text
Claude Code ACP
```

成为首个Worker，项目不取消。

---

# 38. GitHub项目复用原则

直接依赖：

```text
ACP TypeScript SDK
```

重点借设计：

```text
DeepSeek Harness subagent-acp
ACP Bridge
Push
Bernstein
AWS CLI Agent Orchestrator
```

PTY fallback参考：

```text
Coder AgentAPI
```

不直接复制整个项目重写。

---

# 39. 相对Claude V0.3的关键修正

1. ACP-first；
2. 修正Worker不commit时`base..HEAD`拿不到working-tree修改；
3. approve后创建隔离checkpoint commit，解决结果无法稳定集成的问题；
4. 增加RuntimeOwnership；
5. 不提前锁死Bun；
6. Verification“模型不得提供shell字符串”与Windows`.cmd`现实统一；
7. DeepSeek ACP窄能力进入Capability模型；
8. Replay提升为Runtime级契约验证。

---

# 40. 最终原则

Agent Bridge永远保持：

> **Codex负责思考与裁决，Worker负责实施，Bridge负责可靠连接、状态管理和提供可验证事实。**

如果Bridge开始自己调用LLM、自己设计代码或自己判断质量，说明边界已经走错。

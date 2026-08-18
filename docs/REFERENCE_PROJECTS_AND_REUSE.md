# GitHub参考项目与复用策略

**结论：主仓库从零创建。参考项目clone到独立`references/`目录，不直接fork。**

---

## 1. 建议克隆

```powershell
cd D:\AgentBridgeLab\references

git clone --depth 1 https://github.com/deepseek-ai/deepseek-harness.git
git clone --depth 1 https://github.com/allvegetable/acp-bridge.git
git clone --depth 1 https://github.com/owainlewis/push.git
git clone --depth 1 https://github.com/sipyourdrink-ltd/bernstein.git
git clone --depth 1 https://github.com/awslabs/cli-agent-orchestrator.git
git clone --depth 1 https://github.com/coder/agentapi.git
```

ACP SDK直接依赖：

```powershell
npm install @agentclientprotocol/sdk
```

---

## 2. ACP TypeScript SDK

Repository:

`https://github.com/agentclientprotocol/typescript-sdk`

**策略：直接依赖。**

用于：

- ACP Connection；
- protocol types；
- session helpers；
- client/agent methods。

Agent Bridge不重写标准ACP客户端。

---

## 3. DeepSeek Harness

Repository:

`https://github.com/deepseek-ai/deepseek-harness`

重点读：

```text
examples/acp-agent/
packages/acp/acp/
packages/subagent/subagent-acp/
packages/subagent/subagent-dsh-sdk/
packages/test-support/acp-snapshot/
```

最值得借：

### subagent-acp

```text
spawn
→ ACP initialize
→ newSession
→ ownership transfer
→ prompt
→ output
→ cancel
→ dispose/reap
```

重点研究：

- process ownership；
- remote session id与parent run id分离；
- cancellation ladder；
- cwd resolution；
- cleanup。

### subagent-dsh-sdk

用于比较：

```text
ACP Runtime
vs
DeepSeek Native SDK Runtime
```

### acp-snapshot

参考协议录制、snapshot和Replay测试。

DeepSeek Harness当前为Developer Preview，存在breaking changes，因此只作为首个Worker和参考，不作为Bridge代码地基。

---

## 4. ACP Bridge

Repository:

`https://github.com/allvegetable/acp-bridge`

高度相似：

```text
HTTP daemon
↓
ACP
↓
OpenCode / Codex / Claude / Gemini
```

可借：

- ACP launcher；
- preflight；
- doctor；
- diagnose；
- binary missing/protocol mismatch错误分类；
- permission；
- cancel；
- daemon UX。

不fork原因：

本项目还需要更严格的：

- Supervisor Verdict；
- worktree；
- Verification；
- ReviewPacket；
- Rehydrate；
- checkpoint commit；
- Codex掉线恢复。

ACP Bridge为MIT，复制具体代码时保留许可证要求。

---

## 5. Push

Repository:

`https://github.com/owainlewis/push`

重点：

`ARCHITECTURE.md`

最值得借：

### Disposable Agent Runtime

Gateway管理：

```text
routing/history/recovery
```

Agent自己管理：

```text
reasoning/tools/skills/permissions/auth
```

与Agent Bridge边界高度一致。

### Session Rehydration

原Session丢失：

```text
rotate session
↓
bounded context
↓
fresh session retry
```

可参考我们的REHYDRATE。

Push为MIT。

---

## 6. Bernstein

Repository:

`https://github.com/sipyourdrink-ltd/bernstein`

最值得借：

- per-task git worktree；
- quality gates；
- deterministic coordination；
- replay journal；
- audit。

与本项目的：

```text
worktree
Verification
Bridge不调用LLM
Replay
```

方向高度一致。

当前项目自身标记为beta，因此不要作为运行时依赖。

---

## 7. AWS CLI Agent Orchestrator

Repository:

`https://github.com/awslabs/cli-agent-orchestrator`

重点：

`CODEBASE.md`

最值得借：

### Provider与Backend分离

对应本项目：

```text
WorkerProfile
RuntimeDriver
ProcessManager
```

避免一个Agent Adapter同时承担协议、进程、业务状态。

### Event-driven

参考：

```text
Runtime Event
↓
Event Bus
├─ State
├─ Log
├─ Replay
└─ UI
```

---

## 8. Coder AgentAPI

Repository:

`https://github.com/coder/agentapi`

通过terminal emulator控制Coding Agent。

可证明：

> 没有结构化协议时仍可做统一控制。

但缺点：

- TUI依赖；
- ANSI/terminal状态；
- 版本变化脆弱；
- idle/running判断困难。

只作为PTY Fallback参考，不进V1。

---

## 9. OpenCode

ACP docs:

`https://opencode.ai/docs/acp/`

首选：

```text
opencode acp
```

V1不先写OpenCode HTTP Server Adapter。

---

## 10. Claude ACP

Repository:

`https://github.com/agentclientprotocol/claude-agent-acp`

基于Claude Agent SDK提供ACP。

首选ACP Profile。

只有能力缺口时才写Claude Native Runtime。

---

## 11. DeepSeek ACP

入口：

`https://github.com/deepseek-ai/deepseek-harness/blob/master/examples/acp-agent/README.md`

官方当前描述为：

```text
Automation-oriented Agent Client Protocol server
over JSON-RPC stdio
for parent agents / subagent providers / programmatic clients
```

关键package：

```text
packages/acp/acp
```

支持：

- fresh harness session；
- prompt；
- committed assistant output；
- permission；
- cancel。

但Harness仍是Developer Preview，所以必须Phase 0 Probe。

---

## 12. 复用矩阵

| 项目 | 直接依赖 | 复制代码 | 借架构 | 基础fork |
|---|---:|---:|---:|---:|
| ACP TypeScript SDK | ✅ | ❌ | ✅ | ❌ |
| DeepSeek Harness | ❌ | 谨慎 | ✅✅✅ | ❌ |
| ACP Bridge | ❌ | 可少量 | ✅✅ | ❌ |
| Push | ❌ | 可少量 | ✅✅✅ | ❌ |
| Bernstein | ❌ | 可少量 | ✅✅✅ | ❌ |
| AWS CAO | ❌ | 可少量 | ✅✅ | ❌ |
| AgentAPI | ❌ | 暂不 | Fallback | ❌ |

---

## 13. 为什么Clean-room Core更好

Agent Bridge真正的价值不是：

```text
怎么spawn Claude
怎么解析OpenCode
```

这些正在被ACP标准化。

真正价值是：

```text
Codex Supervisor语义
+
Task Contract
+
Worktree
+
Independent Verification
+
ReviewPacket
+
Verdict
+
Continuation/Rehydrate
+
掉线恢复
+
安全边界
```

因此从零建Core不是重复造轮子，而是只自己实现真正属于产品的部分。

---

## 14. 许可证

复制上游实现前：

1. 检查许可证；
2. 保留copyright/license notice；
3. 在`THIRD_PARTY_NOTICES.md`登记；
4. 优先依赖官方package，不vendor源码。

当前已确认：

- DeepSeek Harness：MIT；
- ACP Bridge：MIT；
- Push：MIT；
- ACP TypeScript SDK：Apache-2.0；
- Bernstein：Apache-2.0。

---

## 15. Codex如何使用references目录

可以让Codex：

```text
阅读references/deepseek-harness/packages/subagent/subagent-acp，
只总结进程所有权和dispose设计，不修改参考仓库。
```

或：

```text
参考Bernstein的worktree生命周期，
为我们的WorkspaceManager提出实现方案，不复制其业务层。
```

这种方式比fork后直接大改更可控。

---

## 16. 最终决定

**主仓库：从零。**

**协议：ACP直接复用。**

**DeepSeek/Claude/OpenCode：优先Profile化。**

**类似GitHub项目：clone到独立references目录，作为架构教材和局部实现参考。**

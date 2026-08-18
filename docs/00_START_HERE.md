# Agent Bridge 最终开发指导

**版本：** 2026-08-19 / V1.0.0  
**产品方向：** `docs/PRODUCT_GUIDE.md`（现行后续路线）  
**裁决：** `docs/decisions/ADR-001-post-mvp-direction.md` — **Accepted，路线 B**  
**实现接口：** `Agent_Bridge_Technical_Design_V0.5.md`（架构思想见 V0.4，不要当 backlog）

---

## 1. 最终结论

Agent Bridge主仓库**从零创建，不fork现有类似项目作为地基**。

最终策略：

> **Clean-room Core + ACP-first Runtime + selective reuse**

具体含义：

1. 新建干净`agent-bridge`仓库；
2. Task、Review、Verification、Worktree、Persistence、Security、Codex Integration按本设计自行实现；
3. Worker通信层不重新发明协议，优先使用官方Agent Client Protocol（ACP）及其TypeScript SDK；
4. DeepSeek Harness、Claude Code、OpenCode优先通过ACP接入；
5. ACP缺关键能力时，再增加Agent-specific Native Runtime；
6. PTY/TUI模拟只作为最后Fallback，不进入V1默认路线；
7. GitHub类似项目作为架构参考和局部代码参考，不作为主仓库基础。

---

## 2. 为什么不直接fork现有项目

最接近的`allvegetable/acp-bridge`已经实现HTTP daemon、ACP、permission、cancel、doctor以及多个Coding Agent，但它的目标是通用多Agent orchestrator。

本项目真正的核心是：

- Codex作为唯一Supervisor；
- Worker只负责实施；
- 独立worktree；
- Bridge独立Verification；
- ReviewPacket；
- Codex审核/返工闭环；
- Rehydrate；
- Codex掉线后接手；
- 对Worker结果的确定性验收。

直接fork后仍然需要重写Task生命周期、Review、Verification、Workspace、Persistence和Codex-facing语义，反而会继承额外包袱。

因此：

> **主仓库从零做，但底层协议和成熟工程思想不从零造。**

---

## 3. 推荐本地结构

```text
D:\AgentBridgeLab\
│
├─ agent-bridge\                 ← 正式项目，从零创建
│  ├─ docs\
│  ├─ src\
│  ├─ tests\
│  └─ ...
│
└─ references\                   ← 只读参考，不属于主仓库
   ├─ deepseek-harness\
   ├─ acp-bridge\
   ├─ push\
   ├─ bernstein\
   ├─ cli-agent-orchestrator\
   └─ agentapi\
```

不要把这些参考仓库做成主项目submodule。

---

## 4. 最终架构一句话

```text
Codex / GPT-5.6 Sol
        │
        │ MCP（正式默认） / CLI（调试与Fallback）
        ▼
Agent Bridge Core
        │
        ├─ Task / State / Verdict
        ├─ Worktree
        ├─ Verification
        ├─ ReviewPacket
        ├─ Continuation
        ├─ Persistence / Replay
        └─ Runtime Router
               │
               ├─ ACP Runtime  ← 默认
               │     ├─ DeepSeek Harness
               │     ├─ Claude Code
               │     └─ OpenCode
               │
               ├─ Native Runtime ← ACP能力缺口时
               │
               └─ PTY Fallback  ← 非V1
```

不再默认设计：

```text
DeepSeekHarnessAdapter
ClaudeCodeAdapter
OpenCodeAdapter
```

三套完整通信实现。

优先设计：

```text
AcpRuntimeDriver
+
DeepSeekProfile
ClaudeProfile
OpenCodeProfile
```

---

## 5. 明天第一件事

**不要先写Bridge Core。**

先执行`PHASE0_VALIDATION_PLAN.md`。

第一个技术里程碑：

```text
TypeScript
  ↓
@agentclientprotocol/sdk
  ↓
DeepSeek Harness ACP
  ↓
initialize
  ↓
session/new
  ↓
任务A
  ↓
turn结束
  ↓
第二轮revision
  ↓
成功
```

只有这个链路稳定后，再冻结Core接口。

---

## 6. 当前不要做

- 不直接fork现有orchestrator；
- 不先做GUI；
- 不自己重写ACP JSON-RPC协议；
- 不先锁死Bun；
- 不在Phase 0前写完整Task Manager；
- 不使用浏览器自动化控制Harness UI作为正式通道。

---

## 7. 文档阅读顺序

1. `PRODUCT_GUIDE.md` — **现行产品路线（从这里做）**
2. `decisions/ADR-001-post-mvp-direction.md` — 为何是 MCP stdio V1
3. `Agent_Bridge_Technical_Design_V0.5.md` — 已实现接口
4. `CODEX_SKILL.md` — Codex 接入
5. `Agent_Bridge_Technical_Design_V0.4.md` — 架构思想（历史）
6. `phase0-findings.md` / `capability-matrix.md` — Phase 0 证据
7. `IMPLEMENTATION_ROADMAP.md` — 旧阶段表（历史，勿当 sprint）

---

## 8. Phase 0 已冻结

已生成 `docs/capability-matrix.md`、`docs/phase0-findings.md`，技术设计已升为 `Agent_Bridge_Technical_Design_V0.5.md`。

仍推迟：interactive question 人工闸、Windows Credential Store 具体实现、Bun 单文件、ConPTY。

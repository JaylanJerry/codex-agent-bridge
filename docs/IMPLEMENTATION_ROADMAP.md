# Agent Bridge 实施路线图

**状态：历史文档。** 2026-08-19 起后续工作以 `docs/PRODUCT_GUIDE.md` 与 ADR-001（Accepted / 路线 B）为准。下文 Phase 2 的 SQLite/HTTP、Phase 5 的 GUI/EXE **不是**当前 backlog。

---

## 1. 主仓库

```powershell
mkdir D:\AgentBridgeLab
cd D:\AgentBridgeLab
mkdir agent-bridge
mkdir references
cd agent-bridge
git init
```

把最终文档放进：

```text
agent-bridge\docs\
```

---

## 2. 阶段

```text
Phase 0  验证未知
Phase 1  最小闭环
Phase 2  可靠性
Phase 3  Codex正式接入
Phase 4  Claude/OpenCode
Phase 5  产品化
```

---

## 3. Phase 0A：DeepSeek ACP

只建：

```text
experiments/acp-deepseek/
```

验证：

- initialize；
- session/new；
- prompt；
- events；
- turn end；
- 第二轮prompt；
- permission；
- cancel；
- process exit；
- usage；
- TTY。

不写SQLite、不写GUI、不写完整Core。

---

## 4. Phase 0B：ACP跨Agent烟雾测试

### Claude

```text
claude-agent-acp
```

### OpenCode

```text
opencode acp
```

目标：

> 同一个`AcpRuntimeDriver`至少能驱动两个Agent做最小handshake/session/prompt。

---

## 5. Phase 0C：Codex入口A/B

比较：

```text
CLI
vs
MCP
```

记录：

- 审批次数；
- tool timeout；
- 长等待；
- structured output；
- notification；
- 错误处理。

最终MCP优先，但CLI永久保留。

---

## 6. Phase 0D：Windows工程Spike

测试：

- worktree；
- 中文路径；
- 空格；
- node_modules junction；
- `.env`复制；
- windowsHide；
- Job Object；
- Credential Store；
- Bun compile / Node SEA等打包候选。

---

## 7. Phase 1：最小闭环

**状态（2026-08-18）：已落地，`npm test` 全绿。**

实现：

```text
Core
AcpRuntimeDriver
ReplayRuntimeDriver
DeepSeekProfile
Task Manager
State/Verdict
Worktree
ChangeCollector
Verification Runner
ReviewPacket
```

命令：

```text
run
status
wait
review-packet
diff
approve
continue
reject
respond
logs
```

---

## 8. Phase 1验收

固定fixture repo。

流程：

```text
run
↓
Worker修改
↓
Verification
↓
ReviewPacket
↓
Codex要求返工
↓
continue
↓
Worker修改
↓
Verification
↓
approve
↓
checkpoint commit
↓
Codex cherry-pick测试
```

---

## 9. Phase 2：可靠性

加入：

- append-only journal；
- SQLite；
- idempotency；
- stateVersion；
- tasks --needs-attention；
- Core restart；
- Runtime ownership；
- Session TTL；
- Rehydrate；
- credentials；
- EffectivePermission；
- timeout/stall；
- retention；
- redaction；
- doctor；
- agents。

---

## 10. Phase 3：Codex正式入口

**状态（2026-08-18）：stdio MCP server 已落地**（`src/mcp/server.ts`，与 CLI 共用 `src/api/client.ts`）。

实现MCP server和用户级Skill。

Skill必须教（见 `docs/CODEX_SKILL.md`）：

```text
什么时候委派
run
wait
review-packet
continue
approve
respond
logs
掉线后恢复
什么时候不要Bridge
```

---

## 11. Phase 4：Claude/OpenCode

正常情况下新增的主要内容应该只是：

```text
ClaudeProfile
OpenCodeProfile
```

如果必须为了第二个Agent重写Task Manager/State Machine，说明Runtime抽象失败。

---

## 12. Phase 5：GUI/安装

最后做：

- installer；
- PATH；
- setup；
- credential onboarding；
- WebView2面板；
- update。

---

## 13. 推荐源码目录

Phase 0结束后再创建：

```text
src/
├─ core/
├─ runtime/
│  ├─ contract/
│  ├─ acp/
│  ├─ replay/
│  └─ native/
├─ workers/
│  ├─ deepseek/
│  ├─ claude/
│  └─ opencode/
├─ workspace/
│  ├─ worktree/
│  ├─ changes/
│  └─ integration/
├─ verification/
├─ review/
├─ process/
├─ persistence/
├─ security/
├─ api/
├─ cli/
└─ mcp/
```

---

## 14. Commit建议

```text
feat(acp): prove DeepSeek ACP handshake
feat(runtime): add runtime contract
feat(replay): add replay runtime
feat(worktree): isolate task workspace
feat(changes): collect working-tree changes
feat(verify): add allowlisted verification
feat(review): build review packet
feat(task): add state and verdict
feat(flow): complete two-turn task loop
feat(finalize): create approved checkpoint commit
```

不要一次让模型生成整个项目。

---

## 15. 明天只需要做到

- [ ] 新建主仓库
- [ ] 放入最终文档
- [ ] 建references
- [ ] clone DeepSeek Harness
- [ ] 安装ACP SDK
- [ ] 初始化TypeScript实验
- [ ] 跑通ACP initialize
- [ ] 跑通session/new
- [ ] 跑通first prompt
- [ ] 保存事件
- [ ] 跑通second prompt
- [ ] 写Phase 0 findings

做到这里以前，不写完整Core。

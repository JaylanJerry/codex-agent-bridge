# Phase 0 Findings

**日期：** 2026-08-18  
**仓库：** `C:\Users\jjbon\Documents\Codex\Agent Relay`  
**设计基线：** `Agent_Bridge_Technical_Design_V0.5.md`（架构仍见 V0.4）

当前只稳定 **DeepSeek Harness** 和 **Claude Code**。OpenCode 搁置。

---

## 1. 结论

```text
DeepSeek ACP：CONDITIONAL GO（协议完整；Windows 不能靠它跑测试；无 session/load）
Claude ACP：GO（两轮改代码 + npm test + cancel + session/load）
ACP Runtime：GO（同一 SDK 驱动两个 Worker）
Codex 入口：MCP 优先，CLI 可工作；live A/B 已通过
OpenCode：DEFERRED
Worktree / ChangeCollector / checkpoint：PASS
Ownership / Job Object：PASS（KILL_ON_JOB_CLOSE）
Crash：PASS（保留 worktree，不 reattach，interrupted → AWAITING_REVIEW）
Packaging：GO（Node v24.18.0 + ACP SDK；不锁 Bun）
V0.5：已冻结
```

---

## 2. DeepSeek vs Claude（同一 fixture）

任务相同：修 `add`，补负数测试，第二轮改成 table-driven，不要 commit。

| | DeepSeek | Claude |
|---|---|---|
| 两轮 `end_turn` | 是 | 是 |
| 改了 `math.ts` | 是 | 是 |
| 改了测试 | 是 | 是 |
| 真跑 `npm test` | 否（Windows bash/WSL 失败） | 是 |
| cancel | 是 | 是 |
| usage | 未见 | 每轮都有 |
| 权限选项 | allow-once / reject-once | deny / allow once / always（可切 acceptEdits） |
| cold resume | FAIL（`session/load` Method not found） | PASS（新进程同一 sessionId） |

Claude 两轮证据：`claude-acp-two-turn-summary.json`  
成功后快照：`phase0/artifacts/math-repo-after-claude/`  
工作树已恢复为带 bug 的基线。

含义：Verification Runner 仍然必要——DeepSeek 会尝试测试但在 Windows 上失败；Claude 能跑测试，也不能替代 Bridge 的独立 allowlist。

---

## 3. Codex CLI vs MCP

新账号重跑 `experiments/codex-surface/run-ab.mjs`，两次 `codex exec --json --approve-for-me` 都是 exit 0。

CLI 路径：Codex 用 pwsh 调 `node cli.mjs start` 再 `wait`，8 秒等待完整结束，最后把 JSON 抄进 agent_message。

MCP 路径：Codex 调 `bridge_probe.probe_start` / `probe_wait`，结果在 `structured_content` 里，不必解析 shell 输出。

因此默认入口维持文档决定：**MCP 优先，CLI 永久保留**。Windows 上 CLI 会多一层 PowerShell quoting，正好是 MCP 要避开的问题。

长等待（8s）两边都没有误杀。`--approve-for-me` 下本轮看不到额外审批弹窗计数。

其它工程事实：

- `--sandbox` 不能和 `--approve-for-me` 一起用
- 子进程 stdin 必须 ignore，否则 Codex 等 stdin

---

## 4. Ownership / crash / packaging

- naive `detached:false`：父退子也死（本机）
- Job Object `KILL_ON_JOB_CLOSE`：关 job handle 后子进程死。Core 已用 koffi 调用 `kernel32`，测试覆盖
- `detached:true` external-owned：断开后仍活，Bridge 不得杀
- crash：worktree 文件保留；不 reattach 死 pid；标 `AWAITING_REVIEW` + `interrupted`
- packaging spike：Node v24.18.0 可 import ACP SDK。Bun 1.3.13 存在但 **不锁 Bun**

---

## 5. 明确不做

- 不再扩展 OpenCode prompt/cancel，直到 DeepSeek 与 Claude 的 Core 闭环稳定
- 不因为 OpenCode handshake 过了就写第三个 Profile
- 不 fork 其它 orchestrator
- Bridge 不调 LLM

---

## 6. Phase 1 现状

已实现并可 `npm test`：

- TaskManager + 状态机 + journal + 文件快照
- ReplayRuntimeDriver 两轮返工 + approve checkpoint
- AcpRuntimeDriver（fake ACP：写文件 + cancel）
- ChangeCollector / worktree / Verification Runner / ReviewPacket
- CLI：`run|status|wait|review-packet|diff|approve|continue|reject|logs`

未默认跑：live DeepSeek / Claude（需要本机密钥与额度）。

---

## 7. Go / No-go

```markdown
## DeepSeek
CONDITIONAL GO

## Claude
GO

## OpenCode
DEFERRED

## ACP Runtime
GO（DeepSeek + Claude）

## Codex Surface
MCP primary / CLI keep
live start/wait 与 MCP tool call 均已通过

## Packaging
GO（Node；不锁 Bun）
```

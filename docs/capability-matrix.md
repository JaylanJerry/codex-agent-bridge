# Agent Bridge Capability Matrix

**日期：** 2026-08-18  
**证据目录：** `phase0/artifacts/`  
**Worker 范围：** 只稳定 DeepSeek Harness 与 Claude Code。OpenCode 已搁置。

---

## 1. DeepSeek Harness ACP

| 能力 | 结果 | 证据 |
|---|---|---|
| ACP process可启动 | PASS | `dsh-acp-demo` |
| initialize | PASS | `deepseek-harness-acp@0.0.1` |
| session/new | PASS | |
| prompt | PASS | 两轮任务 |
| structured events | PASS | update + permission |
| deterministic turn-end | PASS | `end_turn` |
| second prompt same live session | PASS | |
| cancel | PASS | `cancelled` |
| permission request | PASS | `allow-once` / `reject-once` |
| usage | NOT OBSERVED | |
| non-TTY | PASS | |
| crash / cold resume | NO-GO for `session/load` | Method not found；只能 REHYDRATE |
| Windows 跑测试 | FAIL | bash `E_ACCESSDENIED`，无 WSL |

---

## 2. Claude Code ACP（`@agentclientprotocol/claude-agent-acp@0.69.0`）

| 能力 | 结果 | 证据 |
|---|---|---|
| initialize / session | PASS | `claude-acp-summary.json` |
| 短 prompt | PASS | PONG + usage |
| 两轮写代码 | PASS | `claude-acp-two-turn-summary.json`；修 add、table-driven 测试，并真正跑了 `npm test` |
| cancel | PASS | `cancelled` |
| permission | PASS | `reject` / `allow` / `allow_always`（可升到 session `acceptEdits`） |
| usage | PASS | 每轮都有 input/output/cached tokens |
| loadSession / resume | PASS | 新进程 `session/load` 同一 sessionId |

---

## 3. OpenCode

**DEFERRED。** handshake 曾通过，不再作为当前 Worker 候选，等 DeepSeek 与 Claude 稳定后再加。

---

## 4. 跨 Agent Runtime

| 项 | 结果 |
|---|---|
| 同一 ACP SDK 驱动 DeepSeek + Claude | PASS |
| 两轮 revision 两边都成立 | PASS |
| cancel 两边都成立 | PASS |
| Phase 1 `AcpRuntimeDriver` + fake ACP | PASS（`tests/acp-driver.test.ts`） |
| Codex MCP `bridge_*` + replay smoke | PASS |
| live Claude via MCP `bridge_run`/`approve` | PASS（修 `add()`，checkpoint 在任务分支） |
| live DeepSeek via MCP `bridge_run`/`approve` | PASS（需注入 `DEEPSEEK_API_KEY`；修 `add()`） |

---

## 5. Codex 入口（新账号重测）

| 指标 | CLI `start`/`wait` | MCP `probe_start`/`probe_wait` |
|---|---|---|
| 结构化参数 | argv，经 pwsh 再包一层，有 quoting | JSON `arguments: {}` |
| 结构化结果 | 从 command stdout 抠 JSON | `structured_content` 对象直接回来 |
| 审批 | `--approve-for-me` 下额外审批 0 | 同左 |
| 长等待 | `waitMs=8000` 完整等到 | 同左 |
| Progress | `command_execution` in_progress → completed | `mcp_tool_call` in_progress → completed |
| 总耗时 | 35.2s | 42.0s |
| `codex exec --json` | PASS | PASS |

证据：`codex-surface-summary.json`、`codex-cli.exec.jsonl`、`codex-mcp.exec.jsonl`。

其它工程事实：

- `--sandbox` 不能和 `--approve-for-me` 一起用
- 子进程 stdin 必须 ignore，否则 Codex 等 stdin

---

## 6. Workspace

| 项 | 结果 |
|---|---|
| worktree 英文/中文/空格 | PASS |
| `.env` / junction / cleanup | PASS |
| ChangeCollector（不 commit，含 ` M path` porcelain） | PASS |
| checkpoint + 主分支不动 | PASS |

---

## 7. Process / packaging

| 项 | 结果 |
|---|---|
| Job Object kill-on-close | PASS（`tests/job-object.test.ts`） |
| crash 不 reattach | PASS（TaskManager `interrupted`） |
| Node + ACP SDK | PASS（v24.18.0） |
| 锁 Bun | NO |

---

## 8. Phase 1 Core

| 项 | 结果 |
|---|---|
| Replay 两轮 + approve | PASS |
| CLI run/continue/approve | PASS |
| review drift 拒绝 | PASS |
| verify allowlist | PASS |

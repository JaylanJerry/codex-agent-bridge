# Agent Bridge Phase 0 验证计划

**目标：** 把所有决定架构生死的未知项变成实测事实。

---

## 1. 必须产出

```text
docs/capability-matrix.md
docs/phase0-findings.md
```

不能只在聊天里说“可以”。

---

## 2. DeepSeek Harness ACP矩阵

| 能力 | 结果 | 证据 |
|---|---|---|
| ACP process可启动 | TBD | |
| initialize | TBD | |
| session/new | TBD | |
| prompt | TBD | |
| structured events | TBD | |
| deterministic turn-end | TBD | |
| second prompt same live session | TBD | |
| cancel | TBD | |
| permission request | TBD | |
| interactive question | TBD | |
| progress | TBD | |
| usage | TBD | |
| non-TTY | TBD | |
| crash behavior | TBD | |
| cold resume | TBD | |
| credential injection | TBD | |

---

## 3. 固定fixture

不要用模糊任务。

例如：

```text
src/math.ts
tests/math.test.ts
```

初始Bug：

```text
add(a,b)错误返回a-b
```

第一轮：

```text
修复add，并增加负数测试。
```

第二轮：

```text
保持现有导出API，把测试改为table-driven形式。
```

---

## 4. 录制

协议frame：

```text
phase0/artifacts/deepseek-acp.ndjson
```

每条增加：

```text
timestamp
direction
seq
```

stderr单独保存。

---

## 5. DeepSeek失败策略

### ACP不可用

尝试DeepSeek Native TypeScript SDK / JSON-RPC。

### ACP缺cold resume

允许：

```text
LIVE_SESSION
↓
Native Resume
↓
REHYDRATE
```

### ACP缺interactive question

允许，降级为：

```text
AWAITING_REVIEW
```

### 无可靠turn end

属于P0阻塞。

Native路径也无法解决时，DeepSeek不作为第一个Worker。

---

## 6. Claude ACP烟雾测试

测试：

```text
claude-agent-acp
```

只需：

- initialize；
- session；
- prompt；
- permission；
- cancel。

---

## 7. OpenCode ACP烟雾测试

测试：

```text
opencode acp
```

同样做：

- initialize；
- session；
- prompt；
- event；
- cancel。

---

## 8. ACP Runtime Go条件

至少两个Agent可以通过同一个Runtime contract完成smoke。

---

## 9. Codex CLI测试

假的probe CLI：

```text
bridge-probe start
bridge-probe wait
```

记录：

```text
approval count
tool timeout
wait behavior
stdout JSON
interrupt behavior
```

---

## 10. Codex MCP测试

最小工具：

```text
probe_start
probe_wait
```

比较：

| 指标 | CLI | MCP |
|---|---|---|
| 结构化参数 | | |
| 结构化结果 | | |
| 审批 | | |
| 长等待 | | |
| Progress | | |
| 错误处理 | | |

---

## 11. Worktree

测试：

- 英文路径；
- 中文路径；
- 空格；
- node_modules；
- `.env`；
- junction；
- cleanup。

---

## 12. ChangeCollector

必须验证：

```text
base HEAD = A
修改a.ts
新建b.ts
删除c.ts
rename d.ts → e.ts
```

Worker不commit。

ChangeCollector必须发现全部变更。

禁止只用：

```text
git diff A..HEAD
```

---

## 13. Approve checkpoint

模拟：

```text
approve
```

步骤：

1. Review对应的ChangeSet hash仍一致；
2. 创建checkpoint commit；
3. 返回commit hash；
4. 原repo cherry-pick；
5. 结果一致。

Review后代码变化必须拒绝approve。

---

## 14. Runtime Ownership

### bridge-owned

Core kill后child必须死。

### external-owned

Bridge断开后外部server必须仍然活。

---

## 15. Packaging Spike

至少覆盖：

- ACP SDK；
- SQLite；
- credential backend；
- process management。

Bun compile不通过时，不为单文件目标扭曲Core架构。

---

## 16. Go/No-go模板

```markdown
# Go/No-go

## DeepSeek
GO / CONDITIONAL / NO-GO

## ACP Runtime
GO / NO-GO

## Codex Surface
MCP / CLI / BOTH

## Packaging
...

## Unsupported Capabilities
...

## Fallbacks
...

## Frozen Interfaces
...
```

---

## 17. Phase 0完成条件

- [ ] Structured Worker runtime可行
- [ ] turn-end可靠
- [ ] two-turn revision可行
- [ ] cancel可行
- [ ] ACP Runtime跨两个Agent smoke
- [ ] Codex入口有实测结论
- [ ] worktree可行
- [ ] ChangeCollector可行
- [ ] checkpoint commit可行
- [ ] packaging至少一个方案可行
- [ ] capability-matrix.md完成
- [ ] phase0-findings.md完成

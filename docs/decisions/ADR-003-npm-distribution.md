# ADR-003: 用 npm 分发，而不是 EXE

## Status
Accepted

## Date
2026-08-19

## Context
V1 内核已经能在作者机上让 Codex 监督 Claude Code。陌生人不能 clone 仓库、跑 `npm install` 再手写 MCP。产品入口是 Codex MCP stdio，`command` 必须是 `node.exe`（Windows 上不能用 `npx.cmd`）。ADR-002 仍留给 HTTP / SQLite / GUI / EXE，此处不重开。

`agent-bridge` 与 `@creatornader/agent-bridge` 已占用 npm 名。Worker（Claude Code / DeepSeek Harness）由用户自己装，Bridge 只带 ACP 接头。

## Decision
发布 npm 包 `codex-agent-bridge`。用户命令：

```text
npx -y codex-agent-bridge
```

安装器把带依赖的运行时落到 `~/.agent-bridge`，再用本机 `node.exe` 写入 `~/.codex/config.toml`。Claude ACP 适配器 `@agentclientprotocol/claude-agent-acp` 作为正式依赖。DeepSeek 只发现用户已有的 Harness（`AGENT_BRIDGE_DEEPSEEK_ROOT` 或常见路径），不随包装走。

## Alternatives Considered

### 单文件 EXE
- Pros: 看起来更像安装器
- Cons: 要捆 Node、签名、更新；Codex 仍然只是 spawn 一个进程；与 ADR-002 冲突
- Rejected: 现在没有「有 Codex、没有 Node」的证据

### 让用户 clone 仓库
- Rejected: 就是这次要去掉的路径

## Consequences
npm 发布后才有真正的一条命令。未登录 npm 时，源码与 `npm pack` 可用，但陌生人不能 `npx`。MCP 名仍是 `agent-bridge`，CLI 名是 `codex-agent-bridge`，避免抢已有 `agent-bridge` bin。

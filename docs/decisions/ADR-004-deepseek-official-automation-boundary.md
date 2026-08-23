# ADR-004: DeepSeek 走官方 ACP automation boundary，不重写 Core

## Status

Accepted architecture, Pending runtime-closure implementation

Phase 4 对 DeepSeek Harness `0.1.1-rc.2` 的结论是 **No-Go**：官方 ACP 协议已是 Product Stable API，但还没有可分发给外部 npm 产品直接启动的完整 ACP coding runtime/profile。production 继续走 legacy source ACP，禁止继续扩张这条路径。

## Date

2026-08-23

证据：`docs/research/deepseek-acp-runtime-spike.md`

---

## Context

Agent Bridge 现有 DeepSeek Worker 已经通过标准 ACP Client（`@agentclientprotocol/sdk` 0.25.1）工作。`TaskManager` 只理解 profile、driver、session、turn、permission、verification 和 review，没有把 DeepSeek 协议硬编码进去。

真正的技术债在 launch boundary：

- production 仍扫描 DeepSeek 源码树，并启动 `packages/examples/acp-demo/src/bin.ts` + `examples/acp-agent/cordis.yml`
- npm 一条命令能装上 Bridge，并不能独立分发 DeepSeek Worker
- README / Product Guide 曾写“启动时继承用户当前持久配置”，对 DeepSeek legacy 路径并不成立。上游 example composition 固定 `provider=deepseek-official`、`model=deepseek-v4-pro`、`reasoningEffort=max`

DeepSeek Harness `0.1.1-rc.2` 把 `@deepseek-ai/dsh-acp` 和 `@deepseek-ai/dsh-sdk-client` 标为 Product — stable API。官方 ACP 提供 `session/cancel` 与 `session/request_permission`，与现有 `bridge_cancel` / `WAITING_FOR_INPUT → bridge_respond` 对齐。

官方 TS SDK 缺少 mid-turn cancel、server→client permission request，且 initialize 仍要显式 provider/model。迁 SDK 会逼 Bridge 参与 route 选择，并破坏现有 permission gate。

Bridge 的产品价值在 Git / review / verification / checkpoint / CAS / guarded apply，不在 Harness transport。

PR #7 试图让 DeepSeek 继承用户持久配置，但它读取 `~/.dsh/settings.yaml` 并用正则改写上游 example YAML。该 PR 已作为 superseded 关闭，不进入 main。

## Decision

- DeepSeek 首选官方 ACP automation boundary，继续复用 generic `AcpRuntimeDriver`。
- 不重写 `TaskManager`，不新增 `WorkerBackend`，不把 DeepSeek 强迁 SDK。
- 不读取 DeepSeek 私有 settings 文件，不 regex patch 上游 example YAML，不把 `model` / `provider` / `effort` 加进 `bridge_run`。
- production 切换以官方 runtime closure Gate 通过为前提。当前 `0.1.1-rc.2` **未通过**。
- SDK 只是 fallback 候选，不是默认目标。
- legacy source ACP 允许短期保留，明确标记为 legacy，禁止继续扩张。
- Bridge 不管理 model / provider / reasoning effort。Claude 继续沿用其原生配置。DeepSeek 的 effective route 由所启动的 Harness ACP composition 决定。
- 若未来引入任何 DeepSeek npm 包，精确固定 prerelease 版本，不用 caret。

## Alternatives Considered

### 迁官方 TS SDK
- Pros: Product Stable API；TypeScript 调用面干净
- Cons: 无 mid-turn cancel、无 permission request、仍需显式 runtime + provider/model；要改 TaskManager 语义
- Rejected: 对现有产品状态机是功能回归

### 合并 PR #7 的 settings/YAML patch
- Pros: 能让 example composition 更接近用户当前模型
- Cons: 把 Bridge 绑到私有 `settings.yaml`、字段名、YAML 缩进和 example 节点 id
- Rejected: 这正是本轮要消除的维护面

### 在 Bridge 里用 Cordis 重拼一套 ACP Harness
- Pros: 表面上不再 clone 源码
- Cons: 要维护大量 DeepSeek 内部插件和 example 级 composition
- Rejected: 等于在 Bridge 里造第二套 Harness

### 把 `dsh-acp-demo` 当 production runtime
- Pros: 有 published bin
- Cons: 官方归类为 Support / example infra；clean install 仍要一份完整 `cordis.yml` 和一组 peer/leaf 插件
- Rejected: 不能把 example 身份假装成 Product runtime

## Consequences

- 文档不再承诺 DeepSeek 会自动继承用户当前持久模型配置。
- `doctor` / `bridge_agents` 应报告 `transport=acp` 和 `integration=official|legacy|missing`，不得把“找到源码树”说成 official runtime ready。
- DeepSeek launch 应抽到独立 resolver，并预留 `resolveOfficialDeepSeekAcpRuntime()`；当前官方入口不存在时返回 `undefined`，不要伪造实现。
- 这两处实现作为后续小 PR，不在本 ADR 里改 production 行为。
- Core、Git 安全、Review、Verification 和 MCP public schema 保持稳定。
- DeepSeek 部分在收尾 PR 完成后冻结。等官方出现正式 ACP runtime/profile 入口后再重新开启迁移。

# Official ACP Runtime Closure Spike

**Date:** 2026-08-23  
**Agent Bridge baseline:** `main @ e5fc8e2616784972ddd5572b64f0de10c3ae465b` (`codex-agent-bridge` 1.1.0)  
**DeepSeek review baseline:** `master @ b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`  
**DeepSeek published packages:** `0.1.1-rc.2`  
**This machine:** Windows 10, Node `v24.18.0`, globally installed `@deepseek-ai/dsh@0.1.1-rc.2`  
**Local source checkout (legacy path only):** `references/deepseek-harness` at `99f6f02` / `dsh-v0.1.0-rc.7`  
**Ubuntu / Node 22:** not executed in this environment. That does not change the conclusion: Windows already shows there is no official spawnable ACP closure.

---

## 1. Question answers

| # | Question | Answer |
|---|---|---|
| 1 | 有没有官方 Product 级可 spawn ACP runtime？ | **No.** `@deepseek-ai/dsh-acp` 是 automation-only 协议插件，不是可执行 runtime。官方文档的 runnable 入口仍是源码仓 `pnpm --dir /path/to/deepseek-harness run demo:acp`。 |
| 2 | 能否通过 `dsh --profile` 正式机制启动？ | **No official ACP profile.** `web` / `headless` 会自动初始化。`dsh --profile acp --dump-config` 失败：`profile "acp" does not exist; create it with 'dsh plugin --profile acp add <package>'`。 |
| 3 | 是否需要维护大量插件依赖？ | **Yes, if we pretended to compose one.** 官方 example `examples/acp-agent/cordis.yml` 是一整棵 DeepSeek 内部插件树（LLM、sandbox、approval、fs、subagent、workflow、hooks…）。这正是禁止项。 |
| 4 | `dsh-acp-demo` 能否在 npm pack clean install 中独立工作？ | **No.** clean install 能装到 bin，但启动要求本地 `./cordis.yml`。官方默认 composition 仍是 example 文件，不是 bundled runtime。 |
| 5 | Windows Node 22/24 是否工作？ | 本机 Node 24：官方 CLI 可跑；**没有官方 ACP runtime 可测。** Node 22 未在本机重复。 |
| 6 | Ubuntu Node 22/24 是否工作？ | **Not run here.** 缺官方 runtime 时跨 OS 矩阵没有可测对象。 |
| 7 | stdout 是否纯 ACP JSON-RPC？ | 官方 `@deepseek-ai/dsh-acp` README 要求 stdout 只走协议帧。`dsh --profile acp` 当前不是 ACP server，因此本项对 official path **N/A**。legacy example 才是 ACP stdio。 |
| 8 | cwd 是否是 task worktree？ | official path **N/A**。现有 Bridge ACP driver 仍把 worktree 传给 `session/new`；launch cwd 在 legacy 路径仍是 Harness 源码根。 |
| 9 | permission 是否能回到 Bridge？ | 官方 ACP 协议支持 `session/request_permission`。没有 official runtime 可做闭环。用户本机 `settings.yaml` 的 `permission.defaultPreset` 是 `danger-full-access`，即使将来“继承用户 home”，也不能直接当 production 默认。 |
| 10 | cancel 是否 quiesce？ | 官方 ACP 文档描述 `session/cancel` + disconnect teardown。没有 official runtime 可测。 |
| 11 | route 是谁决定？ | 官方 ACP 插件：`provider` / `model` optional，但 **runnable composition 两者都要求**。`dsh-acp-demo` 把它们标成 required。legacy example 固定 `deepseek-official` / `deepseek-v4-pro` / `reasoningEffort=max`。Bridge 不得解析 `settings.yaml`。 |
| 12 | `DSH_HOME` 是否被官方机制消费？ | **Yes.** 官方 `dsh` 用 `$DSH_HOME/profiles/<name>`；base bundle 有 settings/credentials 插件。Bridge 可以透传 `DSH_HOME`，但当前 official ACP profile 不存在，透传改变不了 production launch。 |
| 13 | 是否可以完全删除 DeepSeek 源码 checkout 依赖？ | **Not yet.** 删掉 legacy 后，本机没有可启动的官方 ACP coding agent。 |

---

## 2. Installed / inspected packages

| Package | Version | Classification | Role in this spike |
|---|---|---|---|
| `@deepseek-ai/dsh` | `0.1.1-rc.2` | Product CLI | 只有 `web` / `headless` 模板。**不依赖** `@deepseek-ai/dsh-acp`。 |
| `@deepseek-ai/dsh-acp` | `0.1.1-rc.2` | Product — stable API | ACP server **plugin**。无 `bin`。无 `dsh.bundle`。peer：agent / session / llm / approval / attachment / cordis。 |
| `@deepseek-ai/dsh-acp-demo` | `0.1.1-rc.2` | Support / examples | bin `dsh-acp-demo`。repository.directory = `packages/examples/acp-demo`。需要 `./cordis.yml` + 一组 peer/leaf 插件。 |
| `@deepseek-ai/dsh-sdk-client` | `0.1.1-rc.2` | Product — stable API | 备选。无 mid-turn cancel，无 server→client permission，initialize 要 provider/model。 |

Exact CLI:

```text
dsh --version
0.1.1-rc.2

dsh --help
Usage: dsh [options] [command] [args...]
  --profile <name>     the profile under $DSH_HOME/profiles to boot
Commands:
  web                  boot the web profile
  plugin               manage a profile's plugins
Examples mention web / headless / tui. No acp profile.
```

官方 CLI reference（`apps/cli/reference/README.md`）：

- `web` / `headless` 首次使用从 shipped templates 自动初始化
- 任何其他缺失 profile 都失败，并提示 `dsh plugin --profile <name> add <package>`
- shipped apps 的 argv 只有 `web`（host/port）和 `headless`（one-shot task text）

官方 `@deepseek-ai/dsh-acp` README 的 Running 段：

```text
pnpm --dir /path/to/deepseek-harness run demo:acp
```

这仍是源码仓库入口。

---

## 3. Candidate A — official ACP profile/runtime

Command:

```text
dsh --profile acp --dump-config
```

Result (Windows, `@deepseek-ai/dsh@0.1.1-rc.2`):

```text
Error: dsh: profile "acp" does not exist; create it with 'dsh plugin --profile acp add <package>'
```

`$DSH_HOME/profiles` on this machine only contains `web`. Official templates under the global CLI package are agent-presets (`code` / `minimal` / `standard` / `cordis`), not an ACP automation profile.

**Candidate A: fail.**

---

## 4. Candidate B — official profile mechanism, thin composition

Isolated home, no clone of DeepSeek source:

```text
DSH_HOME=%TEMP%\ab-dsh-acp-spike\candidate-b
dsh plugin --profile acp add @deepseek-ai/dsh-acp@0.1.1-rc.2
```

Result:

```text
dsh: initialized profile acp at ...\candidate-b\profiles\acp
dependencies:
+ @deepseek-ai/dsh-acp 0.1.1-rc.2
dsh: warning: @deepseek-ai/dsh-acp declares no dsh.bundle — installed as a plain dependency, not a profile layer
```

Created `package.json`:

```json
{
  "name": "dsh-profile-acp",
  "dependencies": { "@deepseek-ai/dsh-acp": "0.1.1-rc.2" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base"] } }
}
```

`cordis.patch.yml` is an empty array. `dsh --profile acp --dump-config` prints the **dsh-base** tree only. There is **no** `@deepseek-ai/dsh-acp` row, so this profile is not an ACP stdio server.

Isolated dump also shows shipped `agent-default-model` as `deepseek-official` / `deepseek-v4-flash`, and sandbox default `DSH_PERMISSION_MODE ?? 'workspace-write'`. That is the official base bundle, not a Bridge parser. It still does not yield a spawnable ACP coding agent.

Making this work would mean writing and maintaining a Bridge-owned Cordis composition (the example file is dozens of DeepSeek-internal plugins). Spec says that is a failed Candidate B.

**Candidate B: fail.** Official plugin add is supported, but `@deepseek-ai/dsh-acp` is not a profile bundle and does not boot an ACP runtime by itself.

---

## 5. Candidate C — `dsh-acp-demo` clean npm install

```text
mkdir %TEMP%\ab-dsh-acp-spike\candidate-c
npm init -y
npm install --ignore-scripts @deepseek-ai/dsh-acp-demo@0.1.1-rc.2
```

- Install: success, 64 packages
- bin present: `node_modules/.bin/dsh-acp-demo`
- `dsh-acp-demo --help`: `ERR_PARSE_ARGS_UNKNOWN_OPTION`
- `dsh-acp-demo` with no args:

```text
Error: dsh-acp-demo: plugin tree failed to load: config file not found: ...\candidate-c\cordis.yml
```

Official demo README: `dsh-acp-demo [--config path-to-cordis.yml]` defaults to `./cordis.yml`. The shipped composition lives in `examples/acp-agent/cordis.yml` and hardcodes:

```yaml
llm-deepseek:
  thinking: enabled
  reasoningEffort: max
acp-agent:
  provider: deepseek-official
  model: deepseek-v4-pro
```

That is still the example contract. Official docs classify `examples/` as Support / example infra.

**Candidate C: useful as protocol lab only. Not a production backend.**

---

## 6. Candidate D — official TS SDK

Not promoted. `@deepseek-ai/dsh-sdk-client@0.1.1-rc.2` still:

- needs explicit `launch.command/args`
- initialize requires provider/model
- no mid-turn / per-prompt cancel
- no server→client request / approval flow

Choosing it would regress `WAITING_FOR_INPUT` / `bridge_respond` and `session/cancel`. SDK remains a fallback candidate only.

---

## 7. Permission / cancel / route notes (no official runtime to live-test)

Protocol evidence from `@deepseek-ai/dsh-acp` 0.1.1-rc.2 README:

- `session/request_permission` exists
- `session/cancel` exists
- client disconnect / Cordis disposal is documented as ordered teardown
- ACP SDK version is `@agentclientprotocol/sdk@0.25.1`, same as Agent Bridge

This machine's user `~/.dsh/settings.yaml` (not used by Bridge) currently stores:

- `agent-default-model.provider: deepseek-official`
- `agent-default-model.model: deepseek-v4-flash-vision-exp`
- `agent-default-model.reasoningEffort: high`
- `permission.defaultPreset: danger-full-access`

Legacy example route is a different triple (`deepseek-v4-pro` / `max`). That is the documentation bug this branch corrects. If a future official profile really consumed `DSH_HOME` settings, Gate C still forbids relying on `danger-full-access`.

Live permission / cancel / continue / apply loops were **not** run against an official runtime, because none could be started.

---

## 8. Packaging / Windows spawn

- Official `dsh` on Windows is `dsh.ps1` / `.cmd` shim around `node .../@deepseek-ai/dsh/lib/bin.js`. Agent Bridge already refuses to use `.cmd` as MCP `command`; any future official launch must spawn `node.exe` + `lib/bin.js`.
- `dsh plugin` forwards to pnpm. This machine's `dsh plugin add` worked because pnpm is available to the CLI; a clean Windows user with only npm is not proven.
- Ubuntu pack/install of an official ACP runtime was not run; there is no runtime to pack.

---

## 9. Phase 4 judgment

### Verdict: **No-Go**

Failed Go conditions:

- no official Product-level spawnable ACP coding runtime/profile
- cannot start via `dsh --profile` without inventing a Bridge-owned composition
- `dsh-acp-demo` still depends on example `cordis.yml`
- deleting the DeepSeek source checkout would leave no production DeepSeek path
- official permission / cancel / worktree / route closure could not be demonstrated on a product runtime
- Ubuntu matrix has nothing official to test

Passed / still true:

- ACP protocol itself is Product stable and matches Agent Bridge
- existing `AcpRuntimeDriver` should stay
- TaskManager / Git / Review / MCP schema do not need a rewrite
- PR #7 settings/YAML patcher must not land
- `DSH_HOME` is a real official env, safe to pass later, not safe to parse

### Allowed result

```text
1. 修正文档事实。
2. 关闭 PR #7。
3. 把 DeepSeek source integration 明确标成 legacy。
4. 抽离 launch seam。
5. 写好 ADR 和 Spike 证据。
6. Core 完全不动。
7. 等 DeepSeek 官方 runnable ACP 入口。
```

Do **not** enter Phase 5–7.

Re-open Gate A only when DeepSeek ships one of:

- an official `dsh --profile acp` (or equivalent) that is Product-supported
- a published ACP runtime/profile bundle that boots complete coding tools without example source paths
- documented npm/dsh install closure that needs no Bridge-owned plugin tree and no `settings.yaml` regex

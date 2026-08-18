import { existsSync } from "node:fs";
import { join } from "node:path";
import type { WorkerProfile } from "../runtime/contract.ts";
import { loadDeepseekApiKey } from "./credentials.ts";

export const replayProfile: WorkerProfile = {
  id: "replay",
  displayName: "Replay",
  preferredRuntime: "replay",
  ownership: "bridge-owned",
  launch: { command: "replay", args: [] },
};

export function fakeAcpProfile(repoRoot: string): WorkerProfile {
  return {
    id: "fake",
    displayName: "Fake ACP",
    preferredRuntime: "acp",
    ownership: "bridge-owned",
    launch: {
      command: process.execPath,
      args: ["--import", "tsx", join(repoRoot, "tests/fixtures/fake-acp-agent.ts")],
      cwd: repoRoot,
    },
  };
}

export const deepSeekProfile = (launch: WorkerProfile["launch"]): WorkerProfile => ({
  id: "deepseek",
  displayName: "DeepSeek Harness",
  preferredRuntime: "acp",
  ownership: "bridge-owned",
  launch,
});

export const claudeProfile = (launch: WorkerProfile["launch"]): WorkerProfile => ({
  id: "claude",
  displayName: "Claude Code",
  preferredRuntime: "acp",
  ownership: "bridge-owned",
  launch,
});

export function claudeAdapterPath(repoRoot: string): string {
  return join(
    repoRoot,
    "experiments/acp-claude/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js",
  );
}

export function deepSeekHarnessRoot(repoRoot: string): string {
  return join(repoRoot, "references/deepseek-harness");
}

export function resolveClaudeLaunch(repoRoot: string): WorkerProfile["launch"] {
  const adapter = claudeAdapterPath(repoRoot);
  if (!existsSync(adapter)) {
    throw new Error(`Claude ACP adapter missing: ${adapter}`);
  }
  return { command: process.execPath, args: [adapter] };
}

export function resolveDeepSeekLaunch(repoRoot: string): WorkerProfile["launch"] {
  const harness = deepSeekHarnessRoot(repoRoot);
  const bin = join(harness, "packages/examples/acp-demo/src/bin.ts");
  const config = join(harness, "examples/acp-agent/cordis.yml");
  if (!existsSync(bin) || !existsSync(config)) {
    throw new Error(`DeepSeek Harness ACP demo missing under ${harness}`);
  }
  return {
    command: process.execPath,
    args: ["--import", "tsx", bin, "--config", config],
    cwd: harness,
    env: {
      DEEPSEEK_API_KEY: loadDeepseekApiKey(),
      NODE_PATH: join(repoRoot, "node_modules"),
    },
  };
}

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import type { WorkerProfile } from "../runtime/contract.ts";
import { loadDeepseekApiKey } from "./credentials.ts";
import { inheritedDeepSeekHome, inheritDeepSeekAcpConfig, deepSeekInheritedAcpConfigPath } from "./launch-policy.ts";

export const replayProfile: WorkerProfile = {
  id: "replay",
  displayName: "Replay",
  preferredRuntime: "replay",
  ownership: "bridge-owned",
  launch: { command: "replay", args: [] },
};

export function nodeModulePath(packageRoot: string): string {
  const local = join(packageRoot, "node_modules");
  const hoisted = resolve(packageRoot, "..");
  const parts = [local];
  if (hoisted !== local) parts.push(hoisted);
  if (process.env.NODE_PATH) parts.push(process.env.NODE_PATH);
  return [...new Set(parts)].join(delimiter);
}

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

export function isDeepSeekHarnessRoot(root: string): boolean {
  return (
    existsSync(join(root, "packages/examples/acp-demo/src/bin.ts")) &&
    existsSync(join(root, "examples/acp-agent/cordis.yml"))
  );
}

export function deepSeekHarnessCandidates(packageRoot: string): string[] {
  const home = homedir();
  const env = process.env.AGENT_BRIDGE_DEEPSEEK_ROOT?.trim();
  return [
    env,
    join(packageRoot, "references/deepseek-harness"),
    join(home, "deepseek-harness"),
    join(home, ".dsh", "deepseek-harness"),
    join(home, ".dsh"),
  ].filter((item): item is string => Boolean(item));
}

export function deepSeekHarnessRoot(packageRoot: string): string | undefined {
  for (const candidate of deepSeekHarnessCandidates(packageRoot)) {
    if (isDeepSeekHarnessRoot(candidate)) return candidate;
  }
  return undefined;
}

export function claudeAdapterPath(packageRoot: string): string {
  try {
    const require = createRequire(join(packageRoot, "package.json"));
    const pkgJson = require.resolve("@agentclientprotocol/claude-agent-acp/package.json");
    return join(dirname(pkgJson), "dist", "index.js");
  } catch {
    return join(
      packageRoot,
      "experiments/acp-claude/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js",
    );
  }
}

export function resolveClaudeLaunch(packageRoot: string): WorkerProfile["launch"] {
  const adapter = claudeAdapterPath(packageRoot);
  if (!existsSync(adapter)) {
    throw new Error(`Claude ACP adapter missing: ${adapter}`);
  }
  return { command: process.execPath, args: [adapter] };
}

export function resolveDeepSeekLaunch(packageRoot: string): WorkerProfile["launch"] {
  const harness = deepSeekHarnessRoot(packageRoot);
  if (!harness) {
    throw new Error(
      "DeepSeek Harness ACP demo missing (set AGENT_BRIDGE_DEEPSEEK_ROOT or install DeepSeek Harness)",
    );
  }
  const bin = join(harness, "packages/examples/acp-demo/src/bin.ts");
  const demoConfig = join(harness, "examples/acp-agent/cordis.yml");
  const config = inheritDeepSeekAcpConfig(demoConfig, deepSeekInheritedAcpConfigPath());
  return {
    command: process.execPath,
    args: ["--import", "tsx", bin, "--config", config],
    cwd: harness,
    env: {
      DEEPSEEK_API_KEY: loadDeepseekApiKey(),
      NODE_PATH: nodeModulePath(packageRoot),
      DSH_HOME: inheritedDeepSeekHome(),
    },
  };
}

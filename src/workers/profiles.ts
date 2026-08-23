import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join, resolve } from "node:path";
import type { WorkerProfile } from "../runtime/contract.ts";

export {
  deepSeekHarnessCandidates,
  deepSeekHarnessRoot,
  isDeepSeekHarnessRoot,
  resolveDeepSeekLaunch,
} from "./deepseek-launch.ts";

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

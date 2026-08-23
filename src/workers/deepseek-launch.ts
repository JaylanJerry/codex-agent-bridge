import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import type { WorkerProfile } from "../runtime/contract.ts";
import { hasDeepseekApiKey, loadDeepseekApiKey } from "./credentials.ts";

export type DeepSeekLaunchKind = "official" | "legacy" | "missing";

export type DeepSeekOfficialRuntime = {
  kind: "official";
  command: string;
  args: string[];
  version?: string;
  path?: string;
};

export type DeepSeekLaunchReport = {
  transport: "acp";
  integration: DeepSeekLaunchKind;
  runtimePath?: string;
  runtimeVersion?: string;
  home: string;
  homePresent: boolean;
  credentials: "present" | "missing";
};

function nodePathFor(packageRoot: string): string {
  const local = join(packageRoot, "node_modules");
  const hoisted = resolve(packageRoot, "..");
  const parts = [local];
  if (hoisted !== local) parts.push(hoisted);
  if (process.env.NODE_PATH) parts.push(process.env.NODE_PATH);
  return [...new Set(parts)].join(delimiter);
}

/** Official DSH data root. Bridge may pass this through; it does not parse the files inside. */
export function inheritedDeepSeekHome(): string {
  return process.env.DSH_HOME?.trim() || join(homedir(), ".dsh");
}

/**
 * Product-supported official ACP runtime/profile, if one exists.
 * Gate A (0.1.1-rc.2) did not find a spawnable official closure; keep returning undefined
 * until DeepSeek ships one. Do not treat example bins or source checkouts as official.
 */
export function resolveOfficialDeepSeekAcpRuntime(): DeepSeekOfficialRuntime | undefined {
  return undefined;
}

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

export function inspectDeepSeekLaunch(packageRoot: string): DeepSeekLaunchReport {
  const official = resolveOfficialDeepSeekAcpRuntime();
  const harness = deepSeekHarnessRoot(packageRoot);
  const home = inheritedDeepSeekHome();
  const credentials = hasDeepseekApiKey() ? "present" : "missing";
  if (official) {
    return {
      transport: "acp",
      integration: "official",
      runtimePath: official.path,
      runtimeVersion: official.version,
      home,
      homePresent: existsSync(home),
      credentials,
    };
  }
  if (harness) {
    return {
      transport: "acp",
      integration: "legacy",
      runtimePath: harness,
      home,
      homePresent: existsSync(home),
      credentials,
    };
  }
  return {
    transport: "acp",
    integration: "missing",
    home,
    homePresent: existsSync(home),
    credentials,
  };
}

/** Production launch. Still the legacy source/example ACP path until an official runtime exists. */
export function resolveDeepSeekLaunch(packageRoot: string): WorkerProfile["launch"] {
  const harness = deepSeekHarnessRoot(packageRoot);
  if (!harness) {
    throw new Error(
      "DeepSeek Harness ACP demo missing (set AGENT_BRIDGE_DEEPSEEK_ROOT or install DeepSeek Harness)",
    );
  }
  const bin = join(harness, "packages/examples/acp-demo/src/bin.ts");
  const config = join(harness, "examples/acp-agent/cordis.yml");
  return {
    command: process.execPath,
    args: ["--import", "tsx", bin, "--config", config],
    cwd: harness,
    env: {
      DEEPSEEK_API_KEY: loadDeepseekApiKey(),
      NODE_PATH: nodePathFor(packageRoot),
    },
  };
}

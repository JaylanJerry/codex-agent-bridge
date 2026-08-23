import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import type { WorkerProfile } from "../runtime/contract.ts";
import { hasDeepseekApiKey, loadDeepseekApiKey } from "./credentials.ts";

export type DeepSeekIntegration = "official" | "legacy" | "missing";

export type DeepSeekOfficialRuntime = {
  command: string;
  args: string[];
  version?: string;
  path?: string;
};

export type DeepSeekIntegrationReport = {
  transport: "acp";
  integration: DeepSeekIntegration;
  runtimePath?: string;
  home: string;
  homePresent: boolean;
  credentials: "present" | "missing";
};

export type DeepSeekLaunchResolution =
  | {
      type: "legacy" | "official";
      command: string;
      args: string[];
      cwd?: string;
      env?: NodeJS.ProcessEnv;
    }
  | { type: "missing" };

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
 * Product-supported official ACP runtime, if one exists.
 * Keep returning undefined until DeepSeek ships a spawnable closure. Do not fake ready.
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

export function inspectDeepSeekIntegration(packageRoot: string): DeepSeekIntegrationReport {
  const official = resolveOfficialDeepSeekAcpRuntime();
  const harness = deepSeekHarnessRoot(packageRoot);
  const home = inheritedDeepSeekHome();
  const credentials = hasDeepseekApiKey() ? "present" : "missing";
  if (official) {
    return {
      transport: "acp",
      integration: "official",
      runtimePath: official.path,
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

/** Resolve DeepSeek launch. Production still uses legacy source ACP; official stays unresolved. */
export function resolveDeepSeekLaunch(packageRoot: string): DeepSeekLaunchResolution {
  const official = resolveOfficialDeepSeekAcpRuntime();
  if (official) {
    return {
      type: "official",
      command: official.command,
      args: official.args,
    };
  }
  const harness = deepSeekHarnessRoot(packageRoot);
  if (!harness) return { type: "missing" };
  const bin = join(harness, "packages/examples/acp-demo/src/bin.ts");
  const config = join(harness, "examples/acp-agent/cordis.yml");
  return {
    type: "legacy",
    command: process.execPath,
    args: ["--import", "tsx", bin, "--config", config],
    cwd: harness,
    env: {
      DEEPSEEK_API_KEY: loadDeepseekApiKey(),
      NODE_PATH: nodePathFor(packageRoot),
    },
  };
}

export function requireDeepSeekWorkerLaunch(packageRoot: string): WorkerProfile["launch"] {
  const resolved = resolveDeepSeekLaunch(packageRoot);
  if (resolved.type === "missing") {
    throw new Error(
      "DeepSeek Harness ACP demo missing (set AGENT_BRIDGE_DEEPSEEK_ROOT or install DeepSeek Harness)",
    );
  }
  return {
    command: resolved.command,
    args: resolved.args,
    cwd: resolved.cwd,
    env: resolved.env,
  };
}

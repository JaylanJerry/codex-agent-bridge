import { homedir } from "node:os";
import { join } from "node:path";
import type { WorkerProfile } from "../runtime/contract.ts";

export const WORKER_LAUNCH_ENV_ALLOWLIST = new Set(["DEEPSEEK_API_KEY", "NODE_PATH", "DSH_HOME"]);

const MODEL_FLAG = /(?:^|\s)--(?:model|provider|effort|thinking)(?:\s|=|$)/i;
const MODEL_ENV_KEY = /^(?:.+_)?(?:MODEL|PROVIDER|EFFORT|THINKING)(?:_.+)?$/i;

export function inheritedDeepSeekHome(): string {
  const fromEnv = process.env.DSH_HOME?.trim();
  return fromEnv || join(homedir(), ".dsh");
}

export function workerLaunchOverridesConfig(launch: WorkerProfile["launch"]): boolean {
  const argv = [launch.command, ...launch.args].join(" ");
  if (MODEL_FLAG.test(argv)) return true;
  for (const key of Object.keys(launch.env ?? {})) {
    if (!WORKER_LAUNCH_ENV_ALLOWLIST.has(key) || MODEL_ENV_KEY.test(key)) return true;
  }
  return false;
}

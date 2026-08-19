import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { WorkerProfile } from "../runtime/contract.ts";

export const WORKER_LAUNCH_ENV_ALLOWLIST = new Set(["DEEPSEEK_API_KEY", "NODE_PATH", "DSH_HOME"]);

const MODEL_FLAG = /(?:^|\s)--(?:model|provider|effort|thinking)(?:\s|=|$)/i;
const MODEL_ENV_KEY = /^(?:.+_)?(?:MODEL|PROVIDER|EFFORT|THINKING)(?:_.+)?$/i;

export type DeepSeekUserSelection = {
  provider?: string;
  model?: string;
  reasoningEffort?: string;
};

export function inheritedDeepSeekHome(): string {
  const fromEnv = process.env.DSH_HOME?.trim();
  return fromEnv || join(homedir(), ".dsh");
}

export function readDeepSeekUserSelection(home = inheritedDeepSeekHome()): DeepSeekUserSelection {
  const path = join(home, "settings.yaml");
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  const start = text.search(/^agent-default-model:\s*$/m);
  if (start < 0) return {};
  const rest = text.slice(start).split(/\n(?=\S)/)[0] ?? "";
  const pick = (key: string) => rest.match(new RegExp(`^\\s+${key}:\\s*(\\S+)\\s*$`, "m"))?.[1];
  return {
    provider: pick("provider"),
    model: pick("model"),
    reasoningEffort: pick("reasoningEffort"),
  };
}

/** Overlay DSH `agent-default-model` onto a copy of the ACP demo cordis.yml. Not a Bridge model API. */
export function inheritDeepSeekAcpConfig(demoPath: string, destPath: string, selection = readDeepSeekUserSelection()): string {
  let text = readFileSync(demoPath, "utf8");
  if (selection.provider) {
    text = text.replace(/(- id: acp-agent[\s\S]*?\n\s+provider:\s*)\S+/, `$1${selection.provider}`);
  }
  if (selection.model) {
    text = text.replace(/(- id: acp-agent[\s\S]*?\n\s+model:\s*)\S+/, `$1${selection.model}`);
  }
  if (selection.reasoningEffort) {
    text = text.replace(/(- id: llm-deepseek[\s\S]*?\n\s+reasoningEffort:\s*)\S+/, `$1${selection.reasoningEffort}`);
  }
  mkdirSync(dirname(destPath), { recursive: true });
  writeFileSync(destPath, text);
  return destPath;
}

export function deepSeekInheritedAcpConfigPath(): string {
  return join(tmpdir(), `agent-bridge-dsh-acp-${process.pid}.yml`);
}

export function workerLaunchOverridesConfig(launch: WorkerProfile["launch"]): boolean {
  const argv = [launch.command, ...launch.args].join(" ");
  if (MODEL_FLAG.test(argv)) return true;
  for (const key of Object.keys(launch.env ?? {})) {
    if (!WORKER_LAUNCH_ENV_ALLOWLIST.has(key) || MODEL_ENV_KEY.test(key)) return true;
  }
  return false;
}


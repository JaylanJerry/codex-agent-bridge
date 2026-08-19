import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BridgeError, ErrorCodes } from "../core/errors.ts";

export type VerifyCommand = { exe: string; args: string[]; timeoutMs?: number };
export type VerificationPlan = {
  schemaVersion?: string;
  commands: Record<string, VerifyCommand>;
};
export type VerifyResult = { passed: boolean; output: string; skipped: boolean };

function gitShow(repoPath: string, commit: string, path: string): string | undefined {
  const proc = spawnSync("git", ["-c", "core.longpaths=true", "show", `${commit}:${path}`], {
    cwd: repoPath,
    encoding: "utf8",
    windowsHide: true,
  });
  if (proc.status !== 0) return undefined;
  return proc.stdout ?? "";
}

export function parseVerificationPlan(raw: string): VerificationPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new BridgeError(ErrorCodes.VERIFICATION_PLAN_INVALID, String(error));
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BridgeError(ErrorCodes.VERIFICATION_PLAN_INVALID, "verify.json root must be an object");
  }
  const commands = (parsed as { commands?: unknown }).commands;
  if (!commands || typeof commands !== "object" || Array.isArray(commands)) {
    throw new BridgeError(ErrorCodes.VERIFICATION_PLAN_INVALID, "verify.json commands must be an object");
  }
  const normalized: Record<string, VerifyCommand> = {};
  for (const [id, value] of Object.entries(commands as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new BridgeError(ErrorCodes.VERIFICATION_PLAN_INVALID, `invalid command ${id}`);
    }
    const command = value as { exe?: unknown; args?: unknown; timeoutMs?: unknown };
    if (typeof command.exe !== "string" || !Array.isArray(command.args) || !command.args.every((arg) => typeof arg === "string")) {
      throw new BridgeError(ErrorCodes.VERIFICATION_PLAN_INVALID, `invalid command ${id}`);
    }
    normalized[id] = {
      exe: command.exe,
      args: command.args,
      timeoutMs: typeof command.timeoutMs === "number" ? command.timeoutMs : undefined,
    };
  }
  return {
    schemaVersion:
      typeof (parsed as { schemaVersion?: unknown }).schemaVersion === "string"
        ? (parsed as { schemaVersion: string }).schemaVersion
        : undefined,
    commands: normalized,
  };
}

export function loadVerificationPlanFromCommit(repoPath: string, commit: string): VerificationPlan | undefined {
  const raw = gitShow(repoPath, commit, ".agent-bridge/verify.json");
  if (raw === undefined) return undefined;
  return parseVerificationPlan(raw);
}

export function loadVerificationPlanFromWorktree(worktreePath: string): VerificationPlan | undefined {
  const configPath = join(worktreePath, ".agent-bridge", "verify.json");
  if (!existsSync(configPath)) return undefined;
  return parseVerificationPlan(readFileSync(configPath, "utf8"));
}

export function listVerifyIds(plan: VerificationPlan | undefined): string[] {
  return Object.keys(plan?.commands ?? {});
}

export function runVerification(
  worktreePath: string,
  verifyIds: string[],
  plan: VerificationPlan | undefined,
  required: boolean,
): VerifyResult {
  if (!plan) {
    if (required) {
      return { passed: false, output: ErrorCodes.VERIFICATION_PLAN_MISSING, skipped: false };
    }
    return { passed: true, output: "no verification plan at baseCommit", skipped: true };
  }
  let output = "";
  for (const id of verifyIds) {
    const command = plan.commands[id];
    if (!command) {
      return { passed: false, output: `unknown verifyId ${id}`, skipped: false };
    }
    const proc = spawnSync(command.exe, command.args, {
      cwd: worktreePath,
      encoding: "utf8",
      windowsHide: true,
      timeout: command.timeoutMs ?? 120_000,
    });
    output += (proc.stdout ?? "") + (proc.stderr ?? "");
    if (proc.status !== 0) {
      return { passed: false, output, skipped: false };
    }
  }
  return { passed: true, output, skipped: false };
}

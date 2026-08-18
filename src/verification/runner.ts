import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type VerifyResult = { passed: boolean; output: string; skipped: boolean };

export function runVerification(worktreePath: string, verifyIds: string[]): VerifyResult {
  const configPath = join(worktreePath, ".agent-bridge", "verify.json");
  if (!existsSync(configPath)) {
    return { passed: true, output: "no verify.json", skipped: true };
  }
  const config = JSON.parse(readFileSync(configPath, "utf8")) as {
    commands: Record<string, { exe: string; args: string[]; timeoutMs?: number }>;
  };
  let output = "";
  for (const id of verifyIds) {
    const command = config.commands[id];
    if (!command) {
      return { passed: false, output: `unknown verifyId ${id}`, skipped: false };
    }
    const proc = spawnSync(command.exe, command.args, {
      cwd: worktreePath,
      encoding: "utf8",
      windowsHide: true,
      timeout: command.timeoutMs ?? 120_000,
    });
    output += proc.stdout + proc.stderr;
    if (proc.status !== 0) {
      return { passed: false, output, skipped: false };
    }
  }
  return { passed: true, output, skipped: false };
}

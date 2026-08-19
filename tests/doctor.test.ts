import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { runDoctor } from "../src/core/doctor.ts";
import { dispatch } from "../src/api/client.ts";
import { createTaskWorktree } from "../src/workspace/worktree.ts";
import { ensureRepoDataDir } from "../src/persistence/layout.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function git(cwd: string, args: string[]) {
  const proc = spawnSync("git", ["-c", "core.longpaths=true", ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  if (proc.status !== 0) throw new Error(proc.stderr || proc.stdout);
  return proc.stdout.trim();
}

test("doctor reports version, workers, and never prints secret values", async () => {
  const report = runDoctor({ repoRoot });
  assert.match(report.version, /^\d+\.\d+\.\d+/);
  assert.ok(report.checks.some((check) => check.id === "git" && check.ok));
  assert.ok(report.agents.some((agent) => agent.id === "replay" && agent.available));
  const dumped = JSON.stringify(report);
  assert.equal(/sk-[A-Za-z0-9_-]{8,}/.test(dumped), false);
  assert.equal(/DEEPSEEK_API_KEY\s*[=:]\s*\S+/.test(dumped), false);

  const viaDispatch = await dispatch({ command: "doctor" });
  assert.equal(viaDispatch.ok, true);
  assert.equal(viaDispatch.version, report.version);
  assert.ok((viaDispatch.checks ?? []).length > 0);
});

test("doctor can flag verify.json without creating data dirs", async () => {
  const root = mkdtempSync(join(tmpdir(), "ab-doc-"));
  git(root, ["init"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["config", "user.email", "t@t"]);
  writeFileSync(join(root, "README.md"), "x\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "init"]);
  mkdirSync(join(root, ".agent-bridge"), { recursive: true });
  writeFileSync(join(root, ".agent-bridge", "verify.json"), JSON.stringify({ commands: {} }));
  const report = runDoctor({ repoRoot, projectPath: root });
  const verify = report.checks.find((check) => check.id === "verify-json");
  assert.match(verify?.detail ?? "", /present/);
  assert.equal(existsSync(join(root, ".agent-bridge-data")), false);
  rmSync(root, { recursive: true, force: true });
});

test("doctor treats completed-task worktrees as orphans", async () => {
  const root = mkdtempSync(join(tmpdir(), "ab-doc-orphan-"));
  git(root, ["init"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["config", "user.email", "t@t"]);
  writeFileSync(join(root, "README.md"), "x\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "init"]);
  const leftover = createTaskWorktree(root, "old-completed");
  writeFileSync(
    join(ensureRepoDataDir(root), "tasks.json"),
    JSON.stringify({
      tasks: [
        {
          taskId: "old-completed",
          clientRequestId: "old",
          state: "COMPLETED",
          stateVersion: 1,
          verdict: "APPROVED",
          interrupted: false,
          worktreePath: leftover.worktreePath,
          objective: "x",
          projectPath: root,
          workerId: "replay",
        },
      ],
      byRequest: [],
      reviewHashes: [],
    }),
  );
  const report = runDoctor({ repoRoot, projectPath: root });
  const orphans = report.checks.find((check) => check.id === "orphan-worktrees");
  assert.equal(orphans?.ok, false);
  assert.match(orphans?.detail ?? "", /old-completed/);
  rmSync(root, { recursive: true, force: true });
});

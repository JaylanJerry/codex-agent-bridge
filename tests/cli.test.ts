import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const cli = resolve(dirname(fileURLToPath(import.meta.url)), "../src/cli.ts");

function git(cwd: string, args: string[]) {
  const proc = spawnSync("git", ["-c", "core.longpaths=true", ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  if (proc.status !== 0) throw new Error(proc.stderr || proc.stdout);
  return proc.stdout.trim();
}

function bridge(project: string, args: string[]) {
  const proc = spawnSync(process.execPath, ["--import", "tsx", cli, ...args, "--project", project], {
    encoding: "utf8",
    windowsHide: true,
  });
  const parsed = JSON.parse(proc.stdout || "{}") as {
    ok?: boolean;
    task?: {
      taskId: string;
      state: string;
      stateVersion: number;
      approvedCommit?: string;
      worktreePath?: string;
    appliedHead?: string;
    };
    reviewPacket?: { changedFiles: { path: string }[]; verification?: { passed: boolean } };
    error?: string;
    head?: string;
    version?: string;
    checks?: { id: string; ok: boolean }[];
    tasks?: { taskId: string; state: string }[];
  };
  if (proc.status !== 0 && parsed.ok !== false) {
    throw new Error(proc.stderr || proc.stdout || `cli exited ${proc.status}`);
  }
  return { status: proc.status ?? 1, parsed };
}

test("CLI replay loop: run, continue, approve checkpoint", () => {
  const root = mkdtempSync(join(tmpdir(), "ab-cli-"));
  git(root, ["init"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["config", "user.email", "t@t"]);
  writeFileSync(join(root, "src.ts"), "export const v = 1;\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "init"]);

  const base = git(root, ["rev-parse", "HEAD"]);
  const first = bridge(root, [
    "run",
    "--objective",
    "bump v",
    "--worker",
    "replay",
    "--write",
    "src.ts=export const v = 2;\\n",
  ]);
  assert.equal(first.status, 0);
  assert.equal(first.parsed.task?.state, "AWAITING_REVIEW");
  assert.ok(first.parsed.reviewPacket?.changedFiles.some((file) => file.path.replaceAll("\\", "/") === "src.ts"));

  const continued = bridge(root, [
    "continue",
    "--task",
    first.parsed.task!.taskId,
    "--notes",
    "add note",
    "--state-version",
    String(first.parsed.task!.stateVersion),
    "--write",
    "note.md=revised\\n",
  ]);
  assert.equal(continued.status, 0);
  assert.equal(continued.parsed.task?.state, "AWAITING_REVIEW");

  const approved = bridge(root, [
    "approve",
    "--task",
    continued.parsed.task!.taskId,
    "--state-version",
    String(continued.parsed.task!.stateVersion),
  ]);
  assert.equal(approved.status, 0);
  assert.equal(approved.parsed.task?.state, "COMPLETED");
  assert.ok(approved.parsed.task?.approvedCommit);
  assert.equal(git(root, ["rev-parse", "HEAD"]), base);
  assert.notEqual(approved.parsed.task?.approvedCommit, base);
  assert.equal(approved.parsed.task?.worktreePath, undefined);

  const applied = bridge(root, [
    "apply",
    "--task",
    approved.parsed.task!.taskId,
    "--state-version",
    String(approved.parsed.task!.stateVersion),
  ]);
  assert.equal(applied.status, 0);
  assert.equal(git(root, ["rev-parse", "HEAD"]), applied.parsed.task?.appliedHead);
  rmSync(root, { recursive: true, force: true });
});

test("CLI doctor and needs-attention listing", () => {
  const doctor = bridge(process.cwd(), ["doctor"]);
  assert.equal(doctor.status, 0);
  assert.ok(doctor.parsed.version);
  assert.ok((doctor.parsed.checks ?? []).some((check) => check.id === "git" && check.ok));

  const root = mkdtempSync(join(tmpdir(), "ab-cli-attn-"));
  git(root, ["init"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["config", "user.email", "t@t"]);
  writeFileSync(join(root, "src.ts"), "export const v = 1;\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "init"]);
  const first = bridge(root, [
    "run",
    "--objective",
    "bump v",
    "--worker",
    "replay",
    "--write",
    "src.ts=export const v = 2;\\n",
  ]);
  assert.equal(first.status, 0);
  const attention = bridge(root, ["status", "--needs-attention"]);
  assert.equal(attention.status, 0);
  assert.equal(attention.parsed.tasks?.length, 1);
  rmSync(root, { recursive: true, force: true });
});

test("CLI persist review hash so later approve detects drift", () => {
  const root = mkdtempSync(join(tmpdir(), "ab-cli-drift-"));
  git(root, ["init"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["config", "user.email", "t@t"]);
  writeFileSync(join(root, "src.ts"), "export const v = 1;\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "init"]);

  const first = bridge(root, [
    "run",
    "--objective",
    "bump v",
    "--worker",
    "replay",
    "--write",
    "src.ts=export const v = 2;\\n",
  ]);
  assert.equal(first.status, 0);
  writeFileSync(join(first.parsed.task!.worktreePath!, "sneak.ts"), "nope\n");
  const approved = bridge(root, [
    "approve",
    "--task",
    first.parsed.task!.taskId,
    "--state-version",
    String(first.parsed.task!.stateVersion),
  ]);
  assert.equal(approved.status, 1);
  assert.equal(approved.parsed.ok, false);
  assert.match(approved.parsed.error ?? "", /review drift/);
  rmSync(root, { recursive: true, force: true });
});

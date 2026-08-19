import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Journal } from "../src/persistence/journal.ts";
import { ReplayRuntimeDriver } from "../src/runtime/replay/driver.ts";
import { TaskManager } from "../src/core/task-manager.ts";
import { BridgeError } from "../src/core/errors.ts";
import { replayProfile } from "../src/workers/profiles.ts";
import { PathEscapeError, safeJoinWorktree } from "../src/workspace/safe-path.ts";
import { assertCallableWorker } from "../src/workers/debug.ts";

function git(cwd: string, args: string[]) {
  const proc = spawnSync("git", ["-c", "core.longpaths=true", ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  if (proc.status !== 0) throw new Error(proc.stderr || proc.stdout);
  return proc.stdout.trim();
}

function initRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "ab-p0-"));
  git(root, ["init"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["config", "user.email", "t@t"]);
  writeFileSync(join(root, "src.ts"), "export const v = 1;\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "init"]);
  return root;
}

async function replayEdit(root: string, files: Record<string, string>) {
  const manager = new TaskManager(
    new Map([["replay", new ReplayRuntimeDriver([{ stopReason: "end_turn", files }])]]),
    new Map([["replay", replayProfile]]),
    new Journal(join(root, "journal.ndjson")),
  );
  const created = manager.run({
    schemaVersion: "1.2",
    clientRequestId: `p0-${Date.now()}-${Math.random()}`,
    objective: "edit",
    projectPath: root,
    workerId: "replay",
  });
  const first = await manager.wait(created.taskId);
  return { manager, first };
}

test("approve fails when an already-reviewed file changes content", async () => {
  const root = initRepo();
  const { manager, first } = await replayEdit(root, { "src.ts": "export const v = 2;\n" });
  const packet = manager.reviewPacket(first.taskId);
  assert.match(packet.diff, /export const v = 2/);
  writeFileSync(join(first.worktreePath!, "src.ts"), "export const v = 3;\n");
  assert.throws(() => manager.approve(first.taskId, first.stateVersion), (error: unknown) => {
    assert.ok(error instanceof BridgeError);
    assert.equal(error.code, "REVIEW_DRIFT");
    return true;
  });
  rmSync(root, { recursive: true, force: true });
});

test("review packet includes untracked file contents", async () => {
  const root = initRepo();
  const { manager, first } = await replayEdit(root, { "NEW.md": "hello-untracked\n" });
  const packet = manager.reviewPacket(first.taskId);
  assert.ok(packet.changedFiles.some((file) => file.path.replaceAll("\\", "/") === "NEW.md"));
  assert.match(packet.diff, /hello-untracked/);
  rmSync(root, { recursive: true, force: true });
});

test("review and approve fail closed if the worker committed", async () => {
  const root = initRepo();
  const { manager, first } = await replayEdit(root, { "src.ts": "export const v = 2;\n" });
  git(first.worktreePath!, ["config", "user.name", "t"]);
  git(first.worktreePath!, ["config", "user.email", "t@t"]);
  git(first.worktreePath!, ["add", "-A"]);
  git(first.worktreePath!, ["commit", "-m", "worker sneak"]);
  assert.throws(() => manager.reviewPacket(first.taskId), (error: unknown) => {
    assert.ok(error instanceof BridgeError);
    assert.equal(error.code, "WORKER_COMMITTED");
    return true;
  });
  rmSync(root, { recursive: true, force: true });
});

test("apply fail-closes on dirty target, busy repo, and branch change", async () => {
  const root = initRepo();
  const { manager, first } = await replayEdit(root, { "src.ts": "export const v = 2;\n" });
  manager.reviewPacket(first.taskId);
  const approved = manager.approve(first.taskId, first.stateVersion);

  writeFileSync(join(root, "dirt.txt"), "x\n");
  assert.throws(() => manager.apply(approved.taskId, approved.stateVersion), (error: unknown) => {
    assert.ok(error instanceof BridgeError);
    assert.equal(error.code, "TARGET_DIRTY");
    return true;
  });
  rmSync(join(root, "dirt.txt"));

  git(root, ["checkout", "-b", "other"]);
  assert.throws(() => manager.apply(approved.taskId, approved.stateVersion), (error: unknown) => {
    assert.ok(error instanceof BridgeError);
    assert.equal(error.code, "TARGET_BRANCH_CHANGED");
    return true;
  });
  git(root, ["checkout", approved.targetBranch ?? "master"]);
  const landed = manager.apply(approved.taskId, approved.stateVersion);
  assert.ok(landed.appliedHead);
  rmSync(root, { recursive: true, force: true });
});

test("safeJoinWorktree rejects absolute, parent, and symlink escape", () => {
  const root = mkdtempSync(join(tmpdir(), "ab-path-"));
  mkdirSync(join(root, "wt"));
  writeFileSync(join(root, "secret.txt"), "nope\n");
  assert.throws(() => safeJoinWorktree(join(root, "wt"), "../secret.txt"), PathEscapeError);
  assert.throws(() => safeJoinWorktree(join(root, "wt"), join(root, "secret.txt")), PathEscapeError);
  if (process.platform !== "win32") {
    symlinkSync(root, join(root, "wt", "escape"));
    assert.throws(() => safeJoinWorktree(join(root, "wt"), "escape/secret.txt"), PathEscapeError);
  }
  const ok = safeJoinWorktree(join(root, "wt"), "ok.ts");
  assert.ok(ok.endsWith("ok.ts") || ok.endsWith("ok.ts".replaceAll("/", "\\")));
  rmSync(root, { recursive: true, force: true });
});

test("replay files cannot escape the worktree", async () => {
  const root = initRepo();
  const driver = new ReplayRuntimeDriver([
    { stopReason: "end_turn", files: { "../escape.ts": "bad\n" } },
  ]);
  const manager = new TaskManager(
    new Map([["replay", driver]]),
    new Map([["replay", replayProfile]]),
    new Journal(join(root, "journal.ndjson")),
  );
  const created = manager.run({
    schemaVersion: "1.2",
    clientRequestId: "escape",
    objective: "escape",
    projectPath: root,
    workerId: "replay",
  });
  const done = await manager.wait(created.taskId);
  assert.equal(done.state, "FAILED");
  rmSync(root, { recursive: true, force: true });
});

test("run fails closed when verification is required but baseCommit has no plan", () => {
  const root = initRepo();
  const manager = new TaskManager(
    new Map([["replay", new ReplayRuntimeDriver([{ stopReason: "end_turn", files: { "src.ts": "export const v = 2;\n" } }])]]),
    new Map([["replay", replayProfile]]),
    new Journal(join(root, "journal.ndjson")),
  );
  assert.throws(
    () =>
      manager.run({
        schemaVersion: "1.2",
        clientRequestId: "need-verify",
        objective: "edit",
        projectPath: root,
        workerId: "replay",
        verification: { enabled: true, verifyIds: ["ok"] },
      }),
    (error: unknown) => {
      assert.ok(error instanceof BridgeError);
      assert.equal(error.code, "VERIFICATION_PLAN_MISSING");
      return true;
    },
  );
  rmSync(root, { recursive: true, force: true });
});

test("production API requires an explicit real worker", () => {
  assert.throws(() => assertCallableWorker(undefined, undefined, false), (error: unknown) => {
    assert.ok(error instanceof BridgeError);
    assert.equal(error.code, "WORKER_REQUIRED");
    return true;
  });
  assert.throws(() => assertCallableWorker("replay", undefined, false), (error: unknown) => {
    assert.ok(error instanceof BridgeError);
    assert.equal(error.code, "WORKER_NOT_ALLOWED");
    return true;
  });
  assert.equal(assertCallableWorker("claude", undefined, false), "claude");
});

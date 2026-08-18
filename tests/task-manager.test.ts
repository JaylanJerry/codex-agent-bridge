import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Journal } from "../src/persistence/journal.ts";
import { ReplayRuntimeDriver } from "../src/runtime/replay/driver.ts";
import { TaskManager, StateVersionConflictError } from "../src/core/task-manager.ts";
import { replayProfile } from "../src/workers/profiles.ts";

function git(cwd: string, args: string[]) {
  const proc = spawnSync("git", ["-c", "core.longpaths=true", ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  if (proc.status !== 0) throw new Error(proc.stderr || proc.stdout);
  return proc.stdout.trim();
}

test("replay two-turn loop then approve checkpoint", async () => {
  const root = mkdtempSync(join(tmpdir(), "ab-loop-"));
  git(root, ["init"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["config", "user.email", "t@t"]);
  writeFileSync(join(root, "src.ts"), "export const v = 1;\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "init"]);

  const driver = new ReplayRuntimeDriver([
    { stopReason: "end_turn", files: { "src.ts": "export const v = 2;\n" } },
    { stopReason: "end_turn", files: { "note.md": "revised\n" } },
  ]);
  const manager = new TaskManager(
    new Map([["replay", driver]]),
    new Map([["replay", replayProfile]]),
    new Journal(join(root, "journal.ndjson")),
  );

  const created = manager.run({
    schemaVersion: "1.2",
    clientRequestId: "req-1",
    objective: "bump v",
    projectPath: root,
    workerId: "replay",
  });
  const first = await manager.wait(created.taskId);
  assert.equal(first.state, "AWAITING_REVIEW");
  const packet = manager.reviewPacket(created.taskId);
  assert.ok(packet.changedFiles.some((file) => file.path.replaceAll("\\", "/") === "src.ts"));

  const continued = manager.continue(created.taskId, "add note", first.stateVersion);
  const second = await manager.wait(continued.taskId);
  assert.equal(second.state, "AWAITING_REVIEW");
  manager.reviewPacket(second.taskId);
  const approved = manager.approve(second.taskId, second.stateVersion);
  assert.equal(approved.state, "COMPLETED");
  assert.equal(approved.verdict, "APPROVED");
  assert.ok(approved.approvedCommit);
  assert.equal(git(root, ["rev-parse", "HEAD"]), approved.baseCommit);
  rmSync(root, { recursive: true, force: true });
});

test("duplicate clientRequestId is idempotent", async () => {
  const root = mkdtempSync(join(tmpdir(), "ab-id-"));
  git(root, ["init"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["config", "user.email", "t@t"]);
  writeFileSync(join(root, "a.ts"), "1\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "init"]);
  const manager = new TaskManager(
    new Map([["replay", new ReplayRuntimeDriver([{ stopReason: "end_turn" }])]]),
    new Map([["replay", replayProfile]]),
    new Journal(join(root, "journal.ndjson")),
  );
  const input = {
    schemaVersion: "1.2" as const,
    clientRequestId: "same",
    objective: "noop",
    projectPath: root,
    workerId: "replay",
  };
  const a = manager.run(input);
  const b = manager.run(input);
  assert.equal(a.taskId, b.taskId);
  await manager.wait(a.taskId);
  rmSync(root, { recursive: true, force: true });
});

test("crash recovery marks interrupted without reattach", async () => {
  const root = mkdtempSync(join(tmpdir(), "ab-rec-"));
  git(root, ["init"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["config", "user.email", "t@t"]);
  writeFileSync(join(root, "a.ts"), "1\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "init"]);
  const manager = new TaskManager(
    new Map([["replay", new ReplayRuntimeDriver([{ stopReason: "end_turn" }])]]),
    new Map([["replay", replayProfile]]),
    new Journal(join(root, "journal.ndjson")),
  );
  const created = manager.run({
    schemaVersion: "1.2",
    clientRequestId: "crash",
    objective: "x",
    projectPath: root,
    workerId: "replay",
  });
  const running = manager.get(created.taskId);
  const recovered = manager.recoverInterrupted(running.taskId, 999999);
  assert.equal(recovered.interrupted, true);
  assert.equal(recovered.state, "AWAITING_REVIEW");
  await manager.drain(running.taskId);
  rmSync(root, { recursive: true, force: true });
});

test("approve rejects review drift after unreviewed edits", async () => {
  const root = mkdtempSync(join(tmpdir(), "ab-drift-"));
  git(root, ["init"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["config", "user.email", "t@t"]);
  writeFileSync(join(root, "a.ts"), "1\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "init"]);
  const manager = new TaskManager(
    new Map([["replay", new ReplayRuntimeDriver([{ stopReason: "end_turn", files: { "a.ts": "2\n" } }])]]),
    new Map([["replay", replayProfile]]),
    new Journal(join(root, "journal.ndjson")),
  );
  const created = manager.run({
    schemaVersion: "1.2",
    clientRequestId: "drift",
    objective: "edit",
    projectPath: root,
    workerId: "replay",
  });
  const first = await manager.wait(created.taskId);
  manager.reviewPacket(first.taskId);
  writeFileSync(join(first.worktreePath ?? root, "extra.ts"), "sneak\n");
  assert.throws(() => manager.approve(first.taskId, first.stateVersion), /review drift/);
  rmSync(root, { recursive: true, force: true });
});

test("cancel marks task cancelled without waiting for worker", async () => {
  const root = mkdtempSync(join(tmpdir(), "ab-cancel-"));
  git(root, ["init"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["config", "user.email", "t@t"]);
  writeFileSync(join(root, "a.ts"), "1\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "init"]);
  const manager = new TaskManager(
    new Map([["replay", new ReplayRuntimeDriver([{ stopReason: "end_turn" }])]]),
    new Map([["replay", replayProfile]]),
    new Journal(join(root, "journal.ndjson")),
  );
  const created = manager.run({
    schemaVersion: "1.2",
    clientRequestId: "cancel-me",
    objective: "x",
    projectPath: root,
    workerId: "replay",
  });
  const current = manager.get(created.taskId);
  let cancelled;
  try {
    cancelled = await manager.cancel(current.taskId, current.stateVersion);
  } catch (error) {
    if (!(error instanceof StateVersionConflictError)) throw error;
    const latest = manager.get(created.taskId);
    cancelled = await manager.cancel(latest.taskId, latest.stateVersion);
  }
  assert.equal(cancelled.state, "CANCELLED");
  await manager.drain(created.taskId);
  assert.equal(manager.get(created.taskId).state, "CANCELLED");
  rmSync(root, { recursive: true, force: true });
});

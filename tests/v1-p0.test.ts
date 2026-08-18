import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { acquireCoreLock, CoreLockHeldError, inspectCoreLock } from "../src/persistence/lock.ts";
import { FileTaskStore, TaskStoreCorruptedError } from "../src/persistence/store.ts";
import { dispatch } from "../src/api/client.ts";
import { Journal } from "../src/persistence/journal.ts";
import { ReplayRuntimeDriver } from "../src/runtime/replay/driver.ts";
import { TaskManager } from "../src/core/task-manager.ts";
import { replayProfile } from "../src/workers/profiles.ts";
import { createTaskWorktree } from "../src/workspace/worktree.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const holdLock = join(repoRoot, "tests/fixtures/hold-lock.ts");

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

async function waitForFile(path: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path) && readFileSync(path, "utf8").includes("ready")) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${path}`);
}

test("second writer gets CORE_LOCK_HELD and does not hydrate", async () => {
  const root = initRepo();
  const dataDir = join(root, ".agent-bridge-data");
  const ready = join(root, "ready.txt");
  const child = spawn(process.execPath, ["--import", "tsx", holdLock, dataDir, ready], {
    windowsHide: true,
    stdio: "ignore",
  });
  try {
    await waitForFile(ready);
    const result = await dispatch({ command: "status", project: root });
    assert.equal(result.ok, false);
    assert.equal(result.code, "CORE_LOCK_HELD");
    assert.equal(existsSync(join(dataDir, "tasks.json")), false);
  } finally {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test("stale lock is taken over after the holder pid dies", () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-stale-"));
  writeFileSync(join(dir, "core.lock"), `${JSON.stringify({ pid: 999_999_999, startedAt: "2026-01-01T00:00:00.000Z" })}\n`);
  assert.equal(inspectCoreLock(dir).state, "stale");
  const handle = acquireCoreLock(dir);
  assert.equal(handle.pid, process.pid);
  assert.equal(inspectCoreLock(dir).state, "held");
  handle.release();
  rmSync(dir, { recursive: true, force: true });
});

test("unreadable lock is fail-closed and is not deleted", () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-badlock-"));
  const lockPath = join(dir, "core.lock");
  writeFileSync(lockPath, "not-json");
  assert.equal(inspectCoreLock(dir).state, "unreadable");
  assert.throws(() => acquireCoreLock(dir), CoreLockHeldError);
  assert.equal(readFileSync(lockPath, "utf8"), "not-json");
  rmSync(dir, { recursive: true, force: true });
});

test("corrupt tasks.json is TASK_STORE_CORRUPTED not an empty library", async () => {
  const root = initRepo();
  const dataDir = join(root, ".agent-bridge-data");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "tasks.json"), "{not json");
  const store = new FileTaskStore(join(dataDir, "tasks.json"));
  assert.throws(() => store.load(), TaskStoreCorruptedError);
  const result = await dispatch({ command: "status", project: root });
  assert.equal(result.ok, false);
  assert.equal(result.code, "TASK_STORE_CORRUPTED");
  assert.match(readFileSync(join(dataDir, "tasks.json"), "utf8"), /not json/);
  rmSync(root, { recursive: true, force: true });
});

test("tasks.json save replaces via temp file", () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-atomic-"));
  const path = join(dir, "tasks.json");
  const store = new FileTaskStore(path);
  store.save({ tasks: [], byRequest: [], reviewHashes: [] });
  store.save({
    tasks: [
      {
        taskId: "t1",
        clientRequestId: "r1",
        state: "COMPLETED",
        stateVersion: 2,
        verdict: "APPROVED",
        interrupted: false,
        objective: "x",
        projectPath: dir,
        workerId: "replay",
      },
    ],
    byRequest: [["r1", "t1"]],
    reviewHashes: [],
  });
  const loaded = store.load();
  assert.equal(loaded.tasks[0]?.taskId, "t1");
  rmSync(dir, { recursive: true, force: true });
});

test("hydrate recovers FINALIZING after checkpoint and removes leftover worktree", async () => {
  const root = initRepo();
  const manager = new TaskManager(
    new Map([["replay", new ReplayRuntimeDriver([{ stopReason: "end_turn", files: { "src.ts": "export const v = 2;\n" } }])]]),
    new Map([["replay", replayProfile]]),
    new Journal(join(root, "journal.ndjson")),
  );
  const created = manager.run({
    schemaVersion: "1.2",
    clientRequestId: "fin-1",
    objective: "bump",
    projectPath: root,
    workerId: "replay",
  });
  const first = await manager.wait(created.taskId);
  manager.reviewPacket(first.taskId);
  const worktreePath = first.worktreePath!;
  const approved = manager.approve(first.taskId, first.stateVersion);
  const snapshot = manager.snapshot();
  const record = snapshot.tasks[0]!;
  record.state = "FINALIZING";
  record.worktreePath = worktreePath;
  const leftover = createTaskWorktree(root, "leftover-finalizing");
  record.worktreePath = leftover.worktreePath;
  record.taskBranch = leftover.taskBranch;
  writeFileSync(join(leftover.worktreePath, "extra.ts"), "x\n");

  const recovered = new TaskManager(
    new Map([["replay", new ReplayRuntimeDriver([])]]),
    new Map([["replay", replayProfile]]),
    new Journal(join(root, "journal2.ndjson")),
  );
  recovered.hydrate(snapshot);
  const task = recovered.get(created.taskId);
  assert.equal(task.state, "COMPLETED");
  assert.ok(task.approvedCommit);
  assert.equal(task.worktreePath, undefined);
  assert.equal(existsSync(leftover.worktreePath), false);
  assert.equal(recovered.list({ needsAttention: true }).length, 0);
  rmSync(root, { recursive: true, force: true });
});

test("hydrate recovers FINALIZING with uncommitted worktree by creating checkpoint", async () => {
  const root = initRepo();
  const manager = new TaskManager(
    new Map([["replay", new ReplayRuntimeDriver([{ stopReason: "end_turn", files: { "src.ts": "export const v = 2;\n" } }])]]),
    new Map([["replay", replayProfile]]),
    new Journal(join(root, "journal.ndjson")),
  );
  const created = manager.run({
    schemaVersion: "1.2",
    clientRequestId: "fin-2",
    objective: "bump",
    projectPath: root,
    workerId: "replay",
  });
  const first = await manager.wait(created.taskId);
  const snapshot = manager.snapshot();
  const record = snapshot.tasks[0]!;
  record.state = "FINALIZING";
  record.approvedCommit = undefined;
  record.verdict = "APPROVED";
  const recovered = new TaskManager(
    new Map([["replay", new ReplayRuntimeDriver([])]]),
    new Map([["replay", replayProfile]]),
    new Journal(join(root, "journal2.ndjson")),
  );
  recovered.hydrate(snapshot);
  const task = recovered.get(created.taskId);
  assert.equal(task.state, "COMPLETED");
  assert.ok(task.approvedCommit);
  assert.notEqual(task.approvedCommit, task.baseCommit);
  assert.equal(existsSync(first.worktreePath ?? ""), false);
  rmSync(root, { recursive: true, force: true });
});

test("FINALIZING without checkpoint or worktree fails closed and stays visible", () => {
  const root = initRepo();
  const manager = new TaskManager(
    new Map([["replay", new ReplayRuntimeDriver([])]]),
    new Map([["replay", replayProfile]]),
    new Journal(join(root, "journal.ndjson")),
  );
  manager.hydrate({
    tasks: [
      {
        taskId: "stuck",
        clientRequestId: "fin-3",
        state: "FINALIZING",
        stateVersion: 8,
        verdict: "APPROVED",
        interrupted: false,
        objective: "x",
        projectPath: root,
        workerId: "replay",
      },
    ],
    byRequest: [["fin-3", "stuck"]],
    reviewHashes: [],
  });
  const task = manager.get("stuck");
  assert.equal(task.state, "FAILED");
  assert.equal(manager.list({ needsAttention: true }).map((item) => item.taskId).join(), "stuck");
  rmSync(root, { recursive: true, force: true });
});

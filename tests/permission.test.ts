import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Journal } from "../src/persistence/journal.ts";
import { AcpRuntimeDriver } from "../src/runtime/acp/driver.ts";
import { TaskManager } from "../src/core/task-manager.ts";
import { ReplayRuntimeDriver } from "../src/runtime/replay/driver.ts";
import { replayProfile } from "../src/workers/profiles.ts";
import type { WorkerProfile } from "../src/runtime/contract.ts";

const fakeAgent = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/fake-acp-agent.ts");
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

const fakeProfile: WorkerProfile = {
  id: "fake",
  displayName: "Fake ACP",
  preferredRuntime: "acp",
  ownership: "external-owned",
  launch: {
    command: process.execPath,
    args: ["--import", "tsx", fakeAgent],
    cwd: repoRoot,
  },
};

test("permission gate pauses for respond then writes after allow", async () => {
  const root = mkdtempSync(join(tmpdir(), "ab-perm-"));
  git(root, ["init"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["config", "user.email", "t@t"]);
  writeFileSync(join(root, "README.md"), "base\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "init"]);

  const driver = new AcpRuntimeDriver();
  const manager = new TaskManager(
    new Map([["acp", driver]]),
    new Map([["fake", fakeProfile]]),
    new Journal(join(root, "journal.ndjson")),
  );
  const created = manager.run({
    schemaVersion: "1.2",
    clientRequestId: "perm-1",
    objective: "ASK_PERMISSION\nWRITE gated.ts\nexport const n = 1;\n",
    projectPath: root,
    workerId: "fake",
    permissionMode: "gate",
  });
  try {
    const paused = await manager.wait(created.taskId, 15_000);
    assert.equal(paused.state, "WAITING_FOR_INPUT");
    assert.equal(paused.pendingInput?.kind, "permission");
    assert.ok(paused.pendingInput?.options.some((option) => option.optionId === "allow-once"));
    assert.equal(existsSync(join(paused.worktreePath!, "gated.ts")), false);

    manager.respond(paused.taskId, "allow-once", paused.stateVersion);
    const reviewed = await manager.wait(paused.taskId, 15_000);
    assert.equal(reviewed.state, "AWAITING_REVIEW");
    assert.match(readFileSync(join(reviewed.worktreePath!, "gated.ts"), "utf8"), /export const n = 1/);
  } finally {
    const latest = manager.get(created.taskId);
    if (!["COMPLETED", "FAILED", "CANCELLED"].includes(latest.state)) {
      await manager.cancel(latest.taskId, latest.stateVersion).catch(() => undefined);
    }
    await manager.drain(created.taskId).catch(() => undefined);
    if (latest.sessionId) {
      await driver
        .close({
          id: latest.sessionId,
          profileId: "fake",
          worktreePath: latest.worktreePath ?? root,
        })
        .catch(() => undefined);
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("hydrate recovers in-flight states without a live worker", () => {
  const root = mkdtempSync(join(tmpdir(), "ab-perm-hyd-"));
  for (const state of ["QUEUED", "STARTING", "RUNNING", "VERIFYING", "WAITING_FOR_INPUT"] as const) {
    const manager = new TaskManager(new Map(), new Map(), new Journal(join(root, `journal-${state}.ndjson`)));
    manager.hydrate({
      tasks: [
        {
          taskId: `dead-${state}`,
          clientRequestId: "x",
          state,
          stateVersion: 3,
          verdict: null,
          interrupted: false,
          objective: "x",
          projectPath: root,
          workerId: "fake",
          sessionId: "s",
          pendingInput:
            state === "WAITING_FOR_INPUT"
              ? {
                  kind: "permission",
                  sessionId: "s",
                  options: [{ optionId: "allow-once", kind: "allow_once", name: "Allow once" }],
                }
              : undefined,
        },
      ],
      byRequest: [],
      reviewHashes: [],
    });
    const recovered = manager.get(`dead-${state}`);
    assert.equal(recovered.state, "AWAITING_REVIEW", state);
    assert.equal(recovered.interrupted, true, state);
    assert.equal(recovered.pendingInput, undefined, state);
  }
  rmSync(root, { recursive: true, force: true });
});

test("permissionMode is per-task so auto cannot ungated a live gate task", async () => {
  const root = mkdtempSync(join(tmpdir(), "ab-perm-pt-"));
  git(root, ["init"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["config", "user.email", "t@t"]);
  writeFileSync(join(root, "README.md"), "base\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "init"]);
  const driver = new AcpRuntimeDriver();
  const manager = new TaskManager(
    new Map([
      ["acp", driver],
      ["replay", new ReplayRuntimeDriver([{ stopReason: "end_turn", files: { "auto-b.ts": "export const n = 2;\n" } }])],
    ]),
    new Map([
      ["fake", fakeProfile],
      ["replay", replayProfile],
    ]),
    new Journal(join(root, "journal.ndjson")),
  );
  const gated = manager.run({
    schemaVersion: "1.2",
    clientRequestId: "gate-a",
    objective: "ASK_PERMISSION\nWRITE gated-a.ts\nexport const n = 1;\n",
    projectPath: root,
    workerId: "fake",
    permissionMode: "gate",
  });
  try {
    const paused = await manager.wait(gated.taskId, 15_000);
    assert.equal(paused.state, "WAITING_FOR_INPUT");
    const automatic = manager.run({
      schemaVersion: "1.2",
      clientRequestId: "auto-b",
      objective: "bump",
      projectPath: root,
      workerId: "replay",
      permissionMode: "auto",
    });
    const done = await manager.wait(automatic.taskId, 15_000);
    assert.equal(manager.get(gated.taskId).state, "WAITING_FOR_INPUT");
    assert.equal(manager.get(gated.taskId).permissionMode, "gate");
    assert.equal(done.state, "AWAITING_REVIEW");
    assert.equal(done.permissionMode, "auto");
    assert.equal(existsSync(join(paused.worktreePath!, "gated-a.ts")), false);
  } finally {
    const task = manager.get(gated.taskId);
    if (!["COMPLETED", "FAILED", "CANCELLED"].includes(task.state)) {
      await manager.cancel(task.taskId, task.stateVersion).catch(() => undefined);
    }
    await manager.drain(task.taskId).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

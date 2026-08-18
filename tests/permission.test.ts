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
  manager.setPermissionMode("gate");
  const created = manager.run({
    schemaVersion: "1.2",
    clientRequestId: "perm-1",
    objective: "ASK_PERMISSION\nWRITE gated.ts\nexport const n = 1;\n",
    projectPath: root,
    workerId: "fake",
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

test("hydrate recovers WAITING_FOR_INPUT without a live waiter", () => {
  const root = mkdtempSync(join(tmpdir(), "ab-perm-hyd-"));
  const manager = new TaskManager(new Map(), new Map(), new Journal(join(root, "journal.ndjson")));
  manager.hydrate({
    tasks: [
      {
        taskId: "dead-perm",
        clientRequestId: "x",
        state: "WAITING_FOR_INPUT",
        stateVersion: 3,
        verdict: null,
        interrupted: false,
        objective: "x",
        projectPath: root,
        workerId: "fake",
        pendingInput: {
          kind: "permission",
          sessionId: "s",
          options: [{ optionId: "allow-once", kind: "allow_once", name: "Allow once" }],
        },
      },
    ],
    byRequest: [],
    reviewHashes: [],
  });
  const recovered = manager.get("dead-perm");
  assert.equal(recovered.state, "AWAITING_REVIEW");
  assert.equal(recovered.interrupted, true);
  assert.equal(recovered.pendingInput, undefined);
  rmSync(root, { recursive: true, force: true });
});

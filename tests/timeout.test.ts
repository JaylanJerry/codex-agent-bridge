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
import { needsAttention } from "../src/core/state.ts";
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

test("wait budget stops a hanging worker and keeps the worktree", async () => {
  const root = mkdtempSync(join(tmpdir(), "ab-timeout-"));
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
    clientRequestId: "timeout-1",
    objective: "CANCEL_WAIT",
    projectPath: root,
    workerId: "fake",
  });
  try {
    const timed = await manager.wait(created.taskId, 1_500);
    assert.equal(timed.state, "TASK_TIMED_OUT");
    assert.equal(timed.interrupted, true);
    assert.equal(timed.lastStopReason, "wait_timeout");
    assert.ok(timed.worktreePath);
    assert.equal(existsSync(timed.worktreePath), true);
    assert.equal(needsAttention(timed), true);

    manager.continue(
      timed.taskId,
      "WRITE recovered.ts\nexport const n = 3;\n",
      timed.stateVersion,
    );
    const reviewed = await manager.wait(timed.taskId, 15_000);
    assert.equal(reviewed.state, "AWAITING_REVIEW");
    assert.match(readFileSync(join(reviewed.worktreePath!, "recovered.ts"), "utf8"), /export const n = 3/);
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

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKillOnCloseJob, assignPidToJob } from "../src/process/job-object.ts";

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

function heartbeatIs(file: string, previous: string | undefined): boolean {
  try {
    const current = readFileSync(file, "utf8");
    return previous === undefined ? current.length > 0 : current !== previous;
  } catch {
    return false;
  }
}

test("Job Object kill-on-close reaps assigned child", { skip: process.platform !== "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-job-"));
  const hb = join(dir, "hb.txt");
  const child = spawn(
    process.execPath,
    ["-e", `setInterval(() => require('fs').writeFileSync(${JSON.stringify(hb)}, Date.now()+'\\n'), 100);`],
    { stdio: "ignore", windowsHide: true, detached: false },
  );
  try {
    assert.ok(child.pid);
    assert.ok(await waitUntil(() => heartbeatIs(hb, undefined), 10_000), "child never wrote a heartbeat");

    const job = createKillOnCloseJob();
    assignPidToJob(job, child.pid);
    const beforeAssign = readFileSync(hb, "utf8");
    assert.ok(
      await waitUntil(() => heartbeatIs(hb, beforeAssign), 10_000),
      "child stopped writing heartbeats after being assigned to the job",
    );
    assert.equal(pidAlive(child.pid), true);

    job.close();
    // Kill-on-close reaps asynchronously, so poll for the exit instead of
    // assuming a fixed delay; the previous 400ms sleep flaked on loaded runners.
    assert.ok(
      await waitUntil(() => !pidAlive(child.pid), 10_000),
      "child should die when job handle closes",
    );
  } finally {
    if (child.pid && pidAlive(child.pid)) child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

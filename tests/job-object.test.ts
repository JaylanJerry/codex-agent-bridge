import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
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

test("Job Object kill-on-close reaps assigned child", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-job-"));
  const hb = join(dir, "hb.txt");
  const child = spawn(
    process.execPath,
    ["-e", `setInterval(() => require('fs').writeFileSync(${JSON.stringify(hb)}, Date.now()+'\\n'), 100);`],
    { stdio: "ignore", windowsHide: true, detached: false },
  );
  assert.ok(child.pid);
  const job = createKillOnCloseJob();
  assignPidToJob(job, child.pid);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(pidAlive(child.pid), true);
  job.close();
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(pidAlive(child.pid), false, "child should die when job handle closes");
  rmSync(dir, { recursive: true, force: true });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { AcpRuntimeDriver } from "../src/runtime/acp/driver.ts";
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

test("AcpRuntimeDriver drives a fake ACP worker through write and cancel", async () => {
  const root = mkdtempSync(join(tmpdir(), "ab-acp-"));
  git(root, ["init"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["config", "user.email", "t@t"]);
  writeFileSync(join(root, "README.md"), "base\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "init"]);

  const profile: WorkerProfile = {
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
  const driver = new AcpRuntimeDriver();
  const session = await driver.start(profile, root);
  assert.ok(session.id);
  const first = await driver.sendTurn(session, {
    sessionId: session.id,
    text: "WRITE worker.ts\nexport const n = 1;\n",
  });
  assert.equal(first.stopReason, "end_turn");
  assert.match(readFileSync(join(root, "worker.ts"), "utf8"), /export const n = 1/);

  const pending = driver.sendTurn(session, { sessionId: session.id, text: "CANCEL_WAIT" });
  await new Promise((resolve) => setTimeout(resolve, 150));
  await driver.cancel(session);
  const cancelled = await pending;
  assert.equal(cancelled.stopReason, "cancelled");
  await driver.close(session);
  rmSync(root, { recursive: true, force: true });
});

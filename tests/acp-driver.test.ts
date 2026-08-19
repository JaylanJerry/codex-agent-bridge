import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { AcpRuntimeDriver, ACP_STDERR_LIMIT, capText } from "../src/runtime/acp/driver.ts";
import type { WorkerProfile } from "../src/runtime/contract.ts";

const fakeAgent = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/fake-acp-agent.ts");
const hangAgent = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/hang-acp-agent.ts");
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

  const resumedDriver = new AcpRuntimeDriver();
  const resumed = await resumedDriver.start(profile, root, { resumeSessionId: session.id });
  assert.equal(resumed.id, session.id);
  assert.equal(resumed.resumed, true);
  const second = await resumedDriver.sendTurn(resumed, {
    sessionId: resumed.id,
    text: "WRITE resumed.ts\nexport const n = 2;\n",
  });
  assert.equal(second.stopReason, "end_turn");
  assert.match(readFileSync(join(root, "resumed.ts"), "utf8"), /export const n = 2/);
  await resumedDriver.close(resumed);
  rmSync(root, { recursive: true, force: true });
});

function hangProfile(): WorkerProfile {
  return {
    id: "hang",
    displayName: "Hang ACP",
    preferredRuntime: "acp",
    ownership: "external-owned",
    launch: {
      command: process.execPath,
      args: ["--import", "tsx", hangAgent],
      cwd: repoRoot,
    },
  };
}

test("capText keeps the tail within the limit", () => {
  assert.equal(capText("abc", 8), "abc");
  assert.equal(capText("abcdefghijklmnopqrstuvwxyz", 8), "stuvwxyz");
});

test("ACP start times out a worker that never initializes", async () => {
  const root = mkdtempSync(join(tmpdir(), "ab-acp-hang-"));
  const driver = new AcpRuntimeDriver();
  const began = Date.now();
  await assert.rejects(
    () => driver.start(hangProfile(), root, { startupTimeoutMs: 800 }),
    /ACP startup timed out after 800ms/,
  );
  assert.ok(Date.now() - began < 3_000);
  rmSync(root, { recursive: true, force: true });
});

test("ACP start abort signal kills a hanging handshake", async () => {
  const root = mkdtempSync(join(tmpdir(), "ab-acp-abort-"));
  const driver = new AcpRuntimeDriver();
  const controller = new AbortController();
  const pending = driver.start(hangProfile(), root, { signal: controller.signal, startupTimeoutMs: 30_000 });
  setTimeout(() => controller.abort(), 80);
  await assert.rejects(() => pending, /ACP startup aborted/);
  rmSync(root, { recursive: true, force: true });
});

test("ACP start error message caps worker stderr", async () => {
  const root = mkdtempSync(join(tmpdir(), "ab-acp-stderr-"));
  const driver = new AcpRuntimeDriver();
  const error = await driver.start(hangProfile(), root, { startupTimeoutMs: 1_200 }).then(
    () => undefined,
    (caught: unknown) => caught,
  );
  assert.ok(error instanceof Error);
  assert.match(error.message, /ACP startup timed out/);
  assert.ok(error.message.length < ACP_STDERR_LIMIT + 200);
  assert.match(error.message, /noise/);
  rmSync(root, { recursive: true, force: true });
});


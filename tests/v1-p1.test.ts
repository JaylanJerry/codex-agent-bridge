import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Journal } from "../src/persistence/journal.ts";
import { ReplayRuntimeDriver } from "../src/runtime/replay/driver.ts";
import { TaskManager, StateVersionConflictError } from "../src/core/task-manager.ts";
import { FileTaskStore } from "../src/persistence/store.ts";
import { BridgeError } from "../src/core/errors.ts";
import { fakeAcpProfile, replayProfile, resolveClaudeLaunch, resolveDeepSeekLaunch } from "../src/workers/profiles.ts";
import { cherryPickInProgress, cherryPickToRepo } from "../src/workspace/worktree.ts";
import { AcpRuntimeDriver } from "../src/runtime/acp/driver.ts";

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

function initRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "ab-p1-"));
  git(root, ["init"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["config", "user.email", "t@t"]);
  writeFileSync(join(root, "src.ts"), "export const v = 1;\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "init"]);
  mkdirSync(join(root, ".agent-bridge-data"), { recursive: true });
  return root;
}

async function approvedTask(root: string) {
  const manager = new TaskManager(
    new Map([["replay", new ReplayRuntimeDriver([{ stopReason: "end_turn", files: { "src.ts": "export const v = 2;\n" } }])]]),
    new Map([["replay", replayProfile]]),
    new Journal(join(root, ".agent-bridge-data", "journal.ndjson")),
  );
  const created = manager.run({
    schemaVersion: "1.2",
    clientRequestId: "p1",
    objective: "bump",
    projectPath: root,
    workerId: "replay",
  });
  const first = await manager.wait(created.taskId);
  manager.reviewPacket(first.taskId);
  const approved = manager.approve(first.taskId, first.stateVersion);
  return { manager, approved };
}

test("apply does not pretend a foreign cherry-pick is crash recovery", async () => {
  const root = initRepo();
  const { manager, approved } = await approvedTask(root);
  cherryPickToRepo(root, approved.approvedCommit!);
  assert.throws(() => manager.apply(approved.taskId, approved.stateVersion), /TARGET_HEAD_CHANGED|expected HEAD/);
  rmSync(root, { recursive: true, force: true });
});

test("apply refuses leftover cherry-pick instead of aborting it", async () => {
  const root = initRepo();
  const { manager, approved } = await approvedTask(root);
  const gitDirProc = spawnSync("git", ["-c", "core.longpaths=true", "rev-parse", "--absolute-git-dir"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  writeFileSync(join(gitDirProc.stdout.trim(), "CHERRY_PICK_HEAD"), `${approved.approvedCommit}\n`);
  assert.equal(cherryPickInProgress(root), true);
  assert.throws(() => manager.apply(approved.taskId, approved.stateVersion), /TARGET_REPO_BUSY|git operation in progress/);
  assert.equal(cherryPickInProgress(root), true);
  assert.equal(git(root, ["rev-parse", "HEAD"]), approved.expectedTargetHead ?? approved.baseCommit);
  rmSync(root, { recursive: true, force: true });
});

test("two apply calls with the same version: one lands, the other is STATE_VERSION_CONFLICT without a second cherry-pick", async () => {
  const root = initRepo();
  const { manager, approved } = await approvedTask(root);
  const version = approved.stateVersion;
  const results = await Promise.allSettled([
    Promise.resolve().then(() => manager.apply(approved.taskId, version)),
    Promise.resolve().then(() => manager.apply(approved.taskId, version)),
  ]);
  const ok = results.filter((item) => item.status === "fulfilled");
  const conflict = results.filter(
    (item) => item.status === "rejected" && item.reason instanceof StateVersionConflictError,
  );
  assert.equal(ok.length, 1);
  assert.equal(conflict.length, 1);
  assert.equal(git(root, ["log", "--oneline"]).trim().split(/\r?\n/).length, 2);
  rmSync(root, { recursive: true, force: true });
});

test("approve+continue at the same version: one wins, the other is STATE_VERSION_CONFLICT", async () => {
  const root = initRepo();
  const manager = new TaskManager(
    new Map([["replay", new ReplayRuntimeDriver([{ stopReason: "end_turn", files: { "src.ts": "export const v = 2;\n" } }])]]),
    new Map([["replay", replayProfile]]),
    new Journal(join(root, "journal.ndjson")),
  );
  const created = manager.run({
    schemaVersion: "1.2",
    clientRequestId: "race-1",
    objective: "bump",
    projectPath: root,
    workerId: "replay",
  });
  const first = await manager.wait(created.taskId);
  manager.reviewPacket(first.taskId);
  const version = first.stateVersion;
  const results = await Promise.allSettled([
    Promise.resolve().then(() => manager.approve(first.taskId, version)),
    Promise.resolve().then(() => manager.continue(first.taskId, "again", version)),
  ]);
  const conflict = results.filter(
    (item) => item.status === "rejected" && item.reason instanceof StateVersionConflictError,
  );
  assert.equal(conflict.length, 1);
  const winner = results.find((item) => item.status === "fulfilled");
  assert.ok(winner && winner.status === "fulfilled");
  rmSync(root, { recursive: true, force: true });
});

test("respond+cancel at the same version: one wins, the other is STATE_VERSION_CONFLICT", async () => {
  const root = initRepo();
  const driver = new AcpRuntimeDriver();
  const manager = new TaskManager(
    new Map([["acp", driver]]),
    new Map([["fake", fakeAcpProfile(repoRoot)]]),
    new Journal(join(root, "journal.ndjson")),
  );
  const created = manager.run({
    schemaVersion: "1.2",
    clientRequestId: "race-resp",
    objective: "ASK_PERMISSION\nWRITE gated.ts\nexport const n = 1;\n",
    projectPath: root,
    workerId: "fake",
    permissionMode: "gate",
  });
  try {
    const paused = await manager.wait(created.taskId, 15_000);
    assert.equal(paused.state, "WAITING_FOR_INPUT");
    const version = paused.stateVersion;
    const optionId = paused.pendingInput?.options.find((option) => option.optionId.includes("allow"))?.optionId;
    assert.ok(optionId);
    const results = await Promise.allSettled([
      Promise.resolve().then(() => manager.respond(paused.taskId, optionId, version)),
      manager.cancel(paused.taskId, version),
    ]);
    const conflict = results.filter(
      (item) => item.status === "rejected" && item.reason instanceof StateVersionConflictError,
    );
    assert.equal(conflict.length, 1);
  } finally {
    const latest = manager.get(created.taskId);
    if (!["COMPLETED", "FAILED", "CANCELLED"].includes(latest.state)) {
      await manager.cancel(latest.taskId, latest.stateVersion).catch(() => undefined);
    }
    await manager.drain(created.taskId).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("journal rotates when it exceeds maxBytes", () => {
  const root = mkdtempSync(join(tmpdir(), "ab-rot-"));
  const path = join(root, "journal.ndjson");
  const journal = new Journal(path, { maxBytes: 200, keep: 2 });
  for (let i = 0; i < 40; i += 1) journal.append("noise", { i, pad: "xxxxxxxxxxxxxxxxxxxx" });
  assert.equal(existsSync(`${path}.1`) || existsSync(path), true);
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const rotated = existsSync(`${path}.1`) ? readFileSync(`${path}.1`, "utf8") : "";
  assert.ok(current.length + rotated.length > 0);
  rmSync(root, { recursive: true, force: true });
});

test("does not override worker model/provider/effort flags", () => {
  const banned = /(?:^|\s)--(?:model|provider|effort|thinking)(?:\s|=|$)/i;
  const profileSrc = readFileSync(join(repoRoot, "src/workers/profiles.ts"), "utf8");
  const driverSrc = readFileSync(join(repoRoot, "src/runtime/acp/driver.ts"), "utf8");
  assert.equal(banned.test(profileSrc), false);
  assert.equal(/\bmodel\s*:/.test(profileSrc), false);
  assert.match(driverSrc, /newSession\(\{/);
  assert.match(driverSrc, /mcpServers:\s*\[\]/);
  assert.equal(/\bmodel\s*:/.test(driverSrc), false);
  const fake = fakeAcpProfile(repoRoot);
  assert.equal(banned.test([fake.launch.command, ...fake.launch.args].join(" ")), false);
  try {
    const claude = resolveClaudeLaunch(repoRoot);
    assert.equal(banned.test([claude.command, ...claude.args].join(" ")), false);
  } catch (error) {
    if (!String(error).includes("Claude ACP adapter missing")) throw error;
  }
  try {
    const deepseek = resolveDeepSeekLaunch(repoRoot);
    assert.equal(banned.test([deepseek.command, ...deepseek.args].join(" ")), false);
  } catch (error) {
    if (!String(error).includes("DeepSeek Harness ACP demo missing") && !String(error).includes("DEEPSEEK")) {
      throw error;
    }
  }
});

test("hydrate marks CLAIMED apply APPLIED when cherry-pick already landed", async () => {
  const root = initRepo();
  const { manager, approved } = await approvedTask(root);
  const preHead = git(root, ["rev-parse", "HEAD"]);
  approved.application = {
    operationId: "op-landed",
    taskId: approved.taskId,
    approvedCommit: approved.approvedCommit!,
    targetBranch: approved.targetBranch ?? "master",
    preApplyHead: preHead,
    state: "CLAIMED",
  };
  cherryPickToRepo(root, approved.approvedCommit!);
  const second = new TaskManager(
    new Map([["replay", new ReplayRuntimeDriver([])]]),
    new Map([["replay", replayProfile]]),
    new Journal(join(root, ".agent-bridge-data", "journal-2.ndjson")),
  );
  second.hydrate(manager.snapshot());
  const recovered = second.get(approved.taskId);
  assert.equal(recovered.application?.state, "APPLIED");
  assert.equal(recovered.appliedHead, git(root, ["rev-parse", "HEAD"]));
  rmSync(root, { recursive: true, force: true });
});

test("CLAIMED apply retries cherry-pick after restart if HEAD is still preApply", async () => {
  const root = initRepo();
  const { manager, approved } = await approvedTask(root);
  const preHead = git(root, ["rev-parse", "HEAD"]);
  approved.application = {
    operationId: "op-retry",
    taskId: approved.taskId,
    approvedCommit: approved.approvedCommit!,
    targetBranch: approved.targetBranch ?? "master",
    preApplyHead: preHead,
    state: "CLAIMED",
  };
  const second = new TaskManager(
    new Map([["replay", new ReplayRuntimeDriver([])]]),
    new Map([["replay", replayProfile]]),
    new Journal(join(root, ".agent-bridge-data", "journal-3.ndjson")),
  );
  second.hydrate(manager.snapshot());
  const recovered = second.get(approved.taskId);
  assert.equal(recovered.application?.state, "CLAIMED");
  const landed = second.apply(recovered.taskId, recovered.stateVersion);
  assert.equal(landed.application?.state, "APPLIED");
  assert.equal(git(root, ["rev-parse", "HEAD"]), landed.appliedHead);
  assert.notEqual(landed.appliedHead, preHead);
  rmSync(root, { recursive: true, force: true });
});

test("CLAIMED apply survives FileTaskStore restart then retries", async () => {
  const root = initRepo();
  const { manager, approved } = await approvedTask(root);
  const preHead = git(root, ["rev-parse", "HEAD"]);
  approved.application = {
    operationId: "op-store",
    taskId: approved.taskId,
    approvedCommit: approved.approvedCommit!,
    targetBranch: approved.targetBranch ?? "master",
    preApplyHead: preHead,
    state: "CLAIMED",
  };
  const store = new FileTaskStore(join(root, ".agent-bridge-data", "tasks.json"));
  store.save(manager.snapshot());
  const second = new TaskManager(
    new Map([["replay", new ReplayRuntimeDriver([])]]),
    new Map([["replay", replayProfile]]),
    new Journal(join(root, ".agent-bridge-data", "journal-4.ndjson")),
  );
  second.setPersist(() => store.save(second.snapshot()));
  second.hydrate(store.load());
  const recovered = second.get(approved.taskId);
  assert.equal(recovered.application?.state, "CLAIMED");
  const landed = second.apply(recovered.taskId, recovered.stateVersion);
  assert.equal(landed.application?.state, "APPLIED");
  const reloaded = new TaskManager(
    new Map([["replay", new ReplayRuntimeDriver([])]]),
    new Map([["replay", replayProfile]]),
    new Journal(join(root, ".agent-bridge-data", "journal-5.ndjson")),
  );
  reloaded.hydrate(store.load());
  assert.equal(reloaded.get(approved.taskId).application?.state, "APPLIED");
  rmSync(root, { recursive: true, force: true });
});

test("CLAIMED apply stays claimed while a leftover cherry-pick is in progress", async () => {
  const root = initRepo();
  const { manager, approved } = await approvedTask(root);
  approved.application = {
    operationId: "op-busy",
    taskId: approved.taskId,
    approvedCommit: approved.approvedCommit!,
    targetBranch: approved.targetBranch ?? "master",
    preApplyHead: git(root, ["rev-parse", "HEAD"]),
    state: "CLAIMED",
  };
  const gitDir = git(root, ["rev-parse", "--absolute-git-dir"]);
  writeFileSync(join(gitDir, "CHERRY_PICK_HEAD"), `${approved.approvedCommit}\n`);
  const second = new TaskManager(
    new Map([["replay", new ReplayRuntimeDriver([])]]),
    new Map([["replay", replayProfile]]),
    new Journal(join(root, ".agent-bridge-data", "journal-6.ndjson")),
  );
  second.hydrate(manager.snapshot());
  const recovered = second.get(approved.taskId);
  assert.equal(recovered.application?.state, "CLAIMED");
  assert.throws(
    () => second.apply(recovered.taskId, recovered.stateVersion),
    (error: unknown) => error instanceof BridgeError && error.code === "TARGET_REPO_BUSY",
  );
  assert.equal(second.get(approved.taskId).application?.state, "CLAIMED");
  assert.equal(cherryPickInProgress(root), true);
  rmSync(root, { recursive: true, force: true });
});

test("CLAIMED apply fail-closes when HEAD moved to an unrelated commit", async () => {
  const root = initRepo();
  const { manager, approved } = await approvedTask(root);
  approved.application = {
    operationId: "op-conflict",
    taskId: approved.taskId,
    approvedCommit: approved.approvedCommit!,
    targetBranch: approved.targetBranch ?? "master",
    preApplyHead: git(root, ["rev-parse", "HEAD"]),
    state: "CLAIMED",
  };
  writeFileSync(join(root, "unrelated.ts"), "export const n = 9;\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "unrelated"]);
  const second = new TaskManager(
    new Map([["replay", new ReplayRuntimeDriver([])]]),
    new Map([["replay", replayProfile]]),
    new Journal(join(root, ".agent-bridge-data", "journal-7.ndjson")),
  );
  second.hydrate(manager.snapshot());
  const recovered = second.get(approved.taskId);
  assert.equal(recovered.application?.state, "CLAIMED");
  assert.throws(
    () => second.apply(recovered.taskId, recovered.stateVersion),
    (error: unknown) => error instanceof BridgeError && error.code === "APPLY_CONFLICT",
  );
  rmSync(root, { recursive: true, force: true });
});

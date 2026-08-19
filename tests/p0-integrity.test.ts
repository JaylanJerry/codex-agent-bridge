import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, chmodSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Journal } from "../src/persistence/journal.ts";
import { ReplayRuntimeDriver } from "../src/runtime/replay/driver.ts";
import { TaskManager } from "../src/core/task-manager.ts";
import { BridgeError } from "../src/core/errors.ts";
import { replayProfile } from "../src/workers/profiles.ts";
import { PathEscapeError, safeJoinWorktree } from "../src/workspace/safe-path.ts";
import {
  assertCallableWorker,
  assertFilesAllowed,
  assertInPlaceAllowed,
} from "../src/workers/debug.ts";
import { parseDiffRawZ, writeWorktreeResultTree } from "../src/review/snapshot.ts";
import { checkpointFromTree } from "../src/workspace/worktree.ts";
import { buildMcpTools } from "../src/mcp/tools.ts";

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

function dataJournal(root: string) {
  mkdirSync(join(root, ".agent-bridge-data"), { recursive: true });
  return new Journal(join(root, ".agent-bridge-data", "journal.ndjson"));
}

async function replayEdit(root: string, files: Record<string, string>) {
  const manager = new TaskManager(
    new Map([["replay", new ReplayRuntimeDriver([{ stopReason: "end_turn", files }])]]),
    new Map([["replay", replayProfile]]),
    dataJournal(root),
  );
  const created = manager.run({
    schemaVersion: "1.2",
    clientRequestId: `p0-${Date.now()}-${Math.random()}`,
    objective: "edit",
    projectPath: root,
    workerId: "replay",
  });
  const first = await manager.wait(created.taskId);
  return { manager, first };
}

test("approve fails when an already-reviewed file changes content", async () => {
  const root = initRepo();
  const { manager, first } = await replayEdit(root, { "src.ts": "export const v = 2;\n" });
  const packet = manager.reviewPacket(first.taskId);
  assert.match(packet.diff, /export const v = 2/);
  writeFileSync(join(first.worktreePath!, "src.ts"), "export const v = 3;\n");
  assert.throws(() => manager.approve(first.taskId, first.stateVersion), (error: unknown) => {
    assert.ok(error instanceof BridgeError);
    assert.equal(error.code, "REVIEW_DRIFT");
    return true;
  });
  rmSync(root, { recursive: true, force: true });
});

test("review packet includes untracked file contents", async () => {
  const root = initRepo();
  const { manager, first } = await replayEdit(root, { "NEW.md": "hello-untracked\n" });
  const packet = manager.reviewPacket(first.taskId);
  assert.ok(packet.changedFiles.some((file) => file.path.replaceAll("\\", "/") === "NEW.md"));
  assert.match(packet.diff, /hello-untracked/);
  rmSync(root, { recursive: true, force: true });
});

test("review and approve fail closed if the worker committed", async () => {
  const root = initRepo();
  const { manager, first } = await replayEdit(root, { "src.ts": "export const v = 2;\n" });
  git(first.worktreePath!, ["config", "user.name", "t"]);
  git(first.worktreePath!, ["config", "user.email", "t@t"]);
  git(first.worktreePath!, ["add", "-A"]);
  git(first.worktreePath!, ["commit", "-m", "worker sneak"]);
  assert.throws(() => manager.reviewPacket(first.taskId), (error: unknown) => {
    assert.ok(error instanceof BridgeError);
    assert.equal(error.code, "WORKER_COMMITTED");
    return true;
  });
  rmSync(root, { recursive: true, force: true });
});

test("apply fail-closes on dirty target, busy repo, and branch change", async () => {
  const root = initRepo();
  const { manager, first } = await replayEdit(root, { "src.ts": "export const v = 2;\n" });
  manager.reviewPacket(first.taskId);
  const approved = manager.approve(first.taskId, first.stateVersion);

  writeFileSync(join(root, "dirt.txt"), "x\n");
  assert.throws(() => manager.apply(approved.taskId, approved.stateVersion), (error: unknown) => {
    assert.ok(error instanceof BridgeError);
    assert.equal(error.code, "TARGET_DIRTY");
    return true;
  });
  rmSync(join(root, "dirt.txt"));

  git(root, ["checkout", "-b", "other"]);
  assert.throws(() => manager.apply(approved.taskId, approved.stateVersion), (error: unknown) => {
    assert.ok(error instanceof BridgeError);
    assert.equal(error.code, "TARGET_BRANCH_CHANGED");
    return true;
  });
  git(root, ["checkout", approved.targetBranch ?? "master"]);
  const landed = manager.apply(approved.taskId, approved.stateVersion);
  assert.ok(landed.appliedHead);
  rmSync(root, { recursive: true, force: true });
});

test("safeJoinWorktree rejects absolute, parent, and symlink escape", () => {
  const root = mkdtempSync(join(tmpdir(), "ab-path-"));
  mkdirSync(join(root, "wt"));
  writeFileSync(join(root, "secret.txt"), "nope\n");
  assert.throws(() => safeJoinWorktree(join(root, "wt"), "../secret.txt"), PathEscapeError);
  assert.throws(() => safeJoinWorktree(join(root, "wt"), join(root, "secret.txt")), PathEscapeError);
  if (process.platform !== "win32") {
    symlinkSync(root, join(root, "wt", "escape"));
    assert.throws(() => safeJoinWorktree(join(root, "wt"), "escape/secret.txt"), PathEscapeError);
  }
  const ok = safeJoinWorktree(join(root, "wt"), "ok.ts");
  assert.ok(ok.endsWith("ok.ts") || ok.endsWith("ok.ts".replaceAll("/", "\\")));
  rmSync(root, { recursive: true, force: true });
});

test("replay files cannot escape the worktree", async () => {
  const root = initRepo();
  const driver = new ReplayRuntimeDriver([
    { stopReason: "end_turn", files: { "../escape.ts": "bad\n" } },
  ]);
  const manager = new TaskManager(
    new Map([["replay", driver]]),
    new Map([["replay", replayProfile]]),
    dataJournal(root),
  );
  const created = manager.run({
    schemaVersion: "1.2",
    clientRequestId: "escape",
    objective: "escape",
    projectPath: root,
    workerId: "replay",
  });
  const done = await manager.wait(created.taskId);
  assert.equal(done.state, "FAILED");
  rmSync(root, { recursive: true, force: true });
});

test("run fails closed when verification is required but baseCommit has no plan", () => {
  const root = initRepo();
  const manager = new TaskManager(
    new Map([["replay", new ReplayRuntimeDriver([{ stopReason: "end_turn", files: { "src.ts": "export const v = 2;\n" } }])]]),
    new Map([["replay", replayProfile]]),
    dataJournal(root),
  );
  assert.throws(
    () =>
      manager.run({
        schemaVersion: "1.2",
        clientRequestId: "need-verify",
        objective: "edit",
        projectPath: root,
        workerId: "replay",
        verification: { enabled: true, verifyIds: ["ok"] },
      }),
    (error: unknown) => {
      assert.ok(error instanceof BridgeError);
      assert.equal(error.code, "VERIFICATION_PLAN_MISSING");
      return true;
    },
  );
  assert.equal(existsSync(join(root, "agent-bridge")), false);
  rmSync(root, { recursive: true, force: true });
});

test("production API requires an explicit real worker", () => {
  assert.throws(() => assertCallableWorker(undefined, undefined, false), (error: unknown) => {
    assert.ok(error instanceof BridgeError);
    assert.equal(error.code, "WORKER_REQUIRED");
    return true;
  });
  assert.throws(() => assertCallableWorker("replay", undefined, false), (error: unknown) => {
    assert.ok(error instanceof BridgeError);
    assert.equal(error.code, "WORKER_NOT_ALLOWED");
    return true;
  });
  assert.equal(assertCallableWorker("claude", undefined, false), "claude");
  assert.throws(() => assertCallableWorker("claude", { "a.ts": "x" }, true), (error: unknown) => {
    assert.ok(error instanceof BridgeError);
    assert.equal(error.code, "WORKER_NOT_ALLOWED");
    return true;
  });
  assert.throws(() => assertInPlaceAllowed(true, false), (error: unknown) => {
    assert.ok(error instanceof BridgeError);
    assert.equal(error.code, "IN_PLACE_NOT_ALLOWED");
    return true;
  });
  assert.throws(() => assertFilesAllowed("claude", { "a.ts": "x" }, true), (error: unknown) => {
    assert.ok(error instanceof BridgeError);
    assert.equal(error.code, "WORKER_NOT_ALLOWED");
    return true;
  });
  assert.throws(() => parseDiffRawZ(":160000 160000 abcdef0 abcdef1 M\0vendor\0"), (error: unknown) => {
    assert.ok(error instanceof BridgeError);
    assert.equal(error.code, "GITLINK_NOT_SUPPORTED");
    return true;
  });
});

test("production MCP schema hides debug worker, files, and inPlace", () => {
  const prod = buildMcpTools(false);
  const run = prod.find((tool) => tool.name === "bridge_run");
  const worker = run?.inputSchema.properties.worker as { enum?: string[] };
  assert.deepEqual(worker.enum, ["claude", "deepseek"]);
  assert.equal(run?.inputSchema.properties.files, undefined);
  assert.equal(run?.inputSchema.properties.inPlace, undefined);
  const cont = prod.find((tool) => tool.name === "bridge_continue");
  assert.equal(cont?.inputSchema.properties.worker, undefined);
  assert.equal(cont?.inputSchema.properties.files, undefined);
  assert.equal(cont?.inputSchema.properties.permissionMode, undefined);
  assert.ok(run?.inputSchema.properties.permissionMode);
  const dev = buildMcpTools(true);
  const devRun = dev.find((tool) => tool.name === "bridge_run");
  assert.ok(devRun?.inputSchema.properties.files);
  assert.ok(devRun?.inputSchema.properties.inPlace);
});

test("untracked filename with arrow is reviewed, not parsed as rename", async () => {
  const parsed = parseDiffRawZ(":000000 100644 0000000 abcdef0 A\0a -> b\0");
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.path, "a -> b");
  assert.equal(parsed[0]?.change, "added");
  if (process.platform === "win32") return;
  const root = initRepo();
  const { manager, first } = await replayEdit(root, { "a -> b": "arrow-name\n" });
  const packet = manager.reviewPacket(first.taskId);
  assert.ok(packet.changedFiles.some((file) => file.path.replaceAll("\\", "/") === "a -> b"));
  assert.equal(packet.changedFiles.find((file) => file.path.replaceAll("\\", "/") === "a -> b")?.change, "added");
  assert.match(packet.diff, /arrow-name/);
  rmSync(root, { recursive: true, force: true });
});

test("checkpoint commits the reviewed tree, not later worktree writes", async () => {
  const root = initRepo();
  const { first } = await replayEdit(root, { "src.ts": "export const v = 2;\n" });
  const tree = writeWorktreeResultTree(first.worktreePath!, first.baseCommit!);
  writeFileSync(join(first.worktreePath!, "src.ts"), "export const v = 99;\n");
  const commit = checkpointFromTree(
    first.worktreePath!,
    tree,
    first.baseCommit!,
    first.taskBranch!,
    "checkpoint: frozen",
  );
  assert.match(git(first.worktreePath!, ["show", `${commit}:src.ts`]), /export const v = 2/);
  assert.equal(git(first.worktreePath!, ["show", `${commit}:src.ts`]).includes("99"), false);
  assert.equal(git(first.worktreePath!, ["rev-parse", `${commit}~1`]), first.baseCommit);
  rmSync(root, { recursive: true, force: true });
});

test("checkpoint fails closed if HEAD moves after the reviewed tree is frozen", async () => {
  const root = initRepo();
  const { first } = await replayEdit(root, { "src.ts": "export const v = 2;\n" });
  const tree = writeWorktreeResultTree(first.worktreePath!, first.baseCommit!);
  git(first.worktreePath!, ["config", "user.name", "t"]);
  git(first.worktreePath!, ["config", "user.email", "t@t"]);
  git(first.worktreePath!, ["add", "-A"]);
  git(first.worktreePath!, ["commit", "-m", "worker sneak"]);
  assert.throws(
    () =>
      checkpointFromTree(
        first.worktreePath!,
        tree,
        first.baseCommit!,
        first.taskBranch!,
        "checkpoint: frozen",
      ),
    (error: unknown) => {
      assert.ok(error instanceof BridgeError);
      assert.equal(error.code, "WORKER_COMMITTED");
      return true;
    },
  );
  rmSync(root, { recursive: true, force: true });
});

test("untracked binary is reviewed as a git binary patch", async () => {
  const root = initRepo();
  const { manager, first } = await replayEdit(root, {});
  writeFileSync(join(first.worktreePath!, "blob.bin"), Buffer.from([0, 1, 2, 255, 0]));
  const packet = manager.reviewPacket(first.taskId);
  assert.ok(packet.changedFiles.some((file) => file.path.replaceAll("\\", "/") === "blob.bin"));
  assert.match(packet.diff, /GIT binary patch|literal /);
  rmSync(root, { recursive: true, force: true });
});

test("root journal.ndjson makes apply TARGET_DIRTY", async () => {
  const root = initRepo();
  const { manager, first } = await replayEdit(root, { "src.ts": "export const v = 2;\n" });
  manager.reviewPacket(first.taskId);
  const approved = manager.approve(first.taskId, first.stateVersion);
  writeFileSync(join(root, "journal.ndjson"), "{}\n");
  assert.throws(() => manager.apply(approved.taskId, approved.stateVersion), (error: unknown) => {
    assert.ok(error instanceof BridgeError);
    assert.equal(error.code, "TARGET_DIRTY");
    return true;
  });
  rmSync(root, { recursive: true, force: true });
});

test("production cannot continue a persisted replay task", async () => {
  const root = initRepo();
  const { manager, first } = await replayEdit(root, { "src.ts": "export const v = 2;\n" });
  manager.reviewPacket(first.taskId);
  const locked = new TaskManager(
    new Map([["replay", new ReplayRuntimeDriver([])]]),
    new Map([["replay", replayProfile]]),
    dataJournal(root),
    () => false,
  );
  locked.hydrate(manager.snapshot());
  assert.equal(locked.get(first.taskId).state, "AWAITING_REVIEW");
  assert.throws(() => locked.continue(first.taskId, "again", first.stateVersion), (error: unknown) => {
    assert.ok(error instanceof BridgeError);
    assert.equal(error.code, "WORKER_NOT_ALLOWED");
    return true;
  });
  rmSync(root, { recursive: true, force: true });
});

test("production inPlace is rejected", () => {
  const root = initRepo();
  const manager = new TaskManager(
    new Map([["replay", new ReplayRuntimeDriver([{ stopReason: "end_turn", files: { "src.ts": "x\n" } }])]]),
    new Map([["replay", replayProfile]]),
    dataJournal(root),
    () => false,
  );
  assert.throws(
    () =>
      manager.run({
        schemaVersion: "1.2",
        clientRequestId: "inplace",
        objective: "edit",
        projectPath: root,
        workerId: "replay",
        isolation: { mode: "in-place" },
      }),
    (error: unknown) => {
      assert.ok(error instanceof BridgeError);
      assert.equal(error.code, "IN_PLACE_NOT_ALLOWED");
      return true;
    },
  );
  rmSync(root, { recursive: true, force: true });
});

test("invalid verify.json at baseCommit fails closed even without explicit verification", () => {
  const root = initRepo();
  mkdirSync(join(root, ".agent-bridge"), { recursive: true });
  writeFileSync(join(root, ".agent-bridge", "verify.json"), "{not-json");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "bad verify"]);
  const manager = new TaskManager(
    new Map([["replay", new ReplayRuntimeDriver([{ stopReason: "end_turn", files: { "src.ts": "export const v = 2;\n" } }])]]),
    new Map([["replay", replayProfile]]),
    dataJournal(root),
  );
  assert.throws(
    () =>
      manager.run({
        schemaVersion: "1.2",
        clientRequestId: "bad-plan",
        objective: "edit",
        projectPath: root,
        workerId: "replay",
      }),
    (error: unknown) => {
      assert.ok(error instanceof BridgeError);
      assert.equal(error.code, "VERIFICATION_PLAN_INVALID");
      return true;
    },
  );
  rmSync(root, { recursive: true, force: true });
});

test("verify.json whitespace is not drift; delete and invalid are", async () => {
  const root = mkdtempSync(join(tmpdir(), "ab-p0-verify-"));
  git(root, ["init"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["config", "user.email", "t@t"]);
  writeFileSync(join(root, "src.ts"), "export const v = 1;\n");
  mkdirSync(join(root, ".agent-bridge"), { recursive: true });
  const plan = {
    schemaVersion: "1.0",
    commands: { ok: { exe: process.execPath, args: ["-e", "process.stdout.write('ok')"] } },
  };
  writeFileSync(join(root, ".agent-bridge", "verify.json"), JSON.stringify(plan, null, 2));
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "init"]);
  const { manager, first } = await replayEdit(root, { "src.ts": "export const v = 2;\n" });
  writeFileSync(join(first.worktreePath!, ".agent-bridge", "verify.json"), JSON.stringify(plan));
  const unchanged = manager.reviewPacket(first.taskId);
  assert.equal(
    unchanged.warnings.some((warning) => /verification config/i.test(warning)),
    false,
  );
  assert.deepEqual(unchanged.verifyIds, ["ok"]);
  unlinkSync(join(first.worktreePath!, ".agent-bridge", "verify.json"));
  const deleted = manager.reviewPacket(first.taskId);
  assert.ok(deleted.warnings.some((warning) => /verification config/i.test(warning)));
  writeFileSync(join(first.worktreePath!, ".agent-bridge", "verify.json"), "{nope");
  const invalid = manager.reviewPacket(first.taskId);
  assert.ok(invalid.warnings.some((warning) => /verification config/i.test(warning)));
  rmSync(root, { recursive: true, force: true });
});

test("posix quoted filename and executable mode and external symlink enter review", async () => {
  if (process.platform === "win32") return;
  const root = initRepo();
  const { manager, first } = await replayEdit(root, { "src.ts": "export const v = 2;\n" });
  const quoted = join(first.worktreePath!, 'quote"file.ts');
  writeFileSync(quoted, "quoted-secret\n");
  writeFileSync(join(first.worktreePath!, "tool.sh"), "#!/bin/sh\necho hi\n");
  chmodSync(join(first.worktreePath!, "tool.sh"), 0o755);
  symlinkSync("../outside-a", join(first.worktreePath!, "extlink"));
  const packet = manager.reviewPacket(first.taskId);
  assert.match(packet.diff, /quoted-secret/);
  assert.ok(packet.changedFiles.some((file) => file.path.includes('quote"file.ts')));
  assert.match(packet.diff, /new file mode 100755/);
  assert.match(packet.diff, /extlink/);
  unlinkSync(join(first.worktreePath!, "extlink"));
  symlinkSync("../outside-b", join(first.worktreePath!, "extlink"));
  assert.throws(() => manager.approve(first.taskId, first.stateVersion), (error: unknown) => {
    assert.ok(error instanceof BridgeError);
    assert.equal(error.code, "REVIEW_DRIFT");
    return true;
  });
  rmSync(root, { recursive: true, force: true });
});

test("gitlink changes are rejected", async () => {
  const root = initRepo();
  const { manager, first } = await replayEdit(root, { "src.ts": "export const v = 2;\n" });
  const vendor = join(first.worktreePath!, "vendor");
  mkdirSync(vendor);
  git(vendor, ["init"]);
  git(vendor, ["config", "user.name", "t"]);
  git(vendor, ["config", "user.email", "t@t"]);
  writeFileSync(join(vendor, "x.ts"), "nested\n");
  git(vendor, ["add", "."]);
  git(vendor, ["commit", "-m", "nested"]);
  assert.throws(() => manager.reviewPacket(first.taskId), (error: unknown) => {
    assert.ok(error instanceof BridgeError);
    assert.equal(error.code, "GITLINK_NOT_SUPPORTED");
    return true;
  });
  rmSync(root, { recursive: true, force: true });
});


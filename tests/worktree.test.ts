import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  agentBridgeWorktreeId,
  checkpointCommit,
  createTaskWorktree,
  isProtectedAgentBridgeWorktree,
  removeTaskWorktree,
  worktreeKey,
} from "../src/workspace/worktree.ts";

function git(cwd: string, args: string[]) {
  const proc = spawnSync("git", ["-c", "core.longpaths=true", ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  if (proc.status !== 0) throw new Error(proc.stderr || proc.stdout);
  return proc.stdout.trim();
}

test("creates isolated worktree and checkpoint commit", () => {
  const root = mkdtempSync(join(tmpdir(), "ab-wt-"));
  git(root, ["init"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["config", "user.email", "t@t"]);
  writeFileSync(join(root, "README.md"), "base\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "init"]);
  const handle = createTaskWorktree(root, "task-1");
  assert.match(handle.worktreePath.replaceAll("\\", "/"), /\/worktrees\/task-1$/);
  assert.equal(existsSync(join(root, "agent-bridge")), false);
  writeFileSync(join(handle.worktreePath, "wip.ts"), "export const n = 1;\n");
  const commit = checkpointCommit(handle.worktreePath, "checkpoint: task-1");
  assert.notEqual(commit, handle.baseCommit);
  assert.equal(git(root, ["rev-parse", "HEAD"]), handle.baseCommit);
  removeTaskWorktree(handle);
  rmSync(root, { recursive: true, force: true });
});

test("agentBridgeWorktreeId reads the task folder name", () => {
  assert.equal(agentBridgeWorktreeId("/tmp/repo/agent-bridge/abc"), "abc");
  assert.equal(agentBridgeWorktreeId("/tmp/repo/agent-bridge/abc/"), "abc");
  assert.equal(agentBridgeWorktreeId("/tmp/home/repos/deadbeef/worktrees/abc"), "abc");
  assert.equal(isProtectedAgentBridgeWorktree("/tmp/repo/agent-bridge/abc", new Set(), new Set(["abc"])), true);
  assert.equal(isProtectedAgentBridgeWorktree("/tmp/repo/agent-bridge/other", new Set(), new Set(["abc"])), false);
});

test("worktreeKey treats Git Bash and Windows paths as the same location", { skip: process.platform !== "win32" }, () => {
  const windows = "D:\\a\\_temp\\ab-prune-xyz\\agent-bridge\\task-id";
  const mixed = "D:/a/_temp/ab-prune-xyz/agent-bridge/task-id";
  const msys = "/d/a/_temp/ab-prune-xyz/agent-bridge/task-id";
  const cygwin = "/cygdrive/d/a/_temp/ab-prune-xyz/agent-bridge/task-id";
  assert.equal(worktreeKey(windows), worktreeKey(mixed));
  assert.equal(worktreeKey(windows), worktreeKey(msys));
  assert.equal(worktreeKey(windows), worktreeKey(cygwin));
  assert.equal(agentBridgeWorktreeId(msys), "task-id");
  const protectedKeys = new Set([worktreeKey(windows)]);
  const protectedIds = new Set(["task-id"]);
  assert.equal(isProtectedAgentBridgeWorktree(msys, new Set(), protectedIds), true);
  assert.equal(isProtectedAgentBridgeWorktree(mixed, protectedKeys, new Set()), true);
  assert.equal(isProtectedAgentBridgeWorktree("/d/a/_temp/ab-prune-xyz/agent-bridge/other", protectedKeys, protectedIds), false);
});

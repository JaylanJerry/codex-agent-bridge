import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { checkpointCommit, createTaskWorktree, removeTaskWorktree } from "../src/workspace/worktree.ts";

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
  writeFileSync(join(handle.worktreePath, "wip.ts"), "export const n = 1;\n");
  const commit = checkpointCommit(handle.worktreePath, "checkpoint: task-1");
  assert.notEqual(commit, handle.baseCommit);
  assert.equal(git(root, ["rev-parse", "HEAD"]), handle.baseCommit);
  removeTaskWorktree(handle);
  rmSync(root, { recursive: true, force: true });
});

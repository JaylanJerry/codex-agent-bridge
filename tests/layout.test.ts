import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  ensureRepoDataDir,
  legacyDataDir,
  repoDataDir,
  repoId,
} from "../src/persistence/layout.ts";
import { createTaskWorktree, removeTaskWorktree } from "../src/workspace/worktree.ts";

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
  const root = mkdtempSync(join(tmpdir(), "ab-layout-"));
  git(root, ["init"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["config", "user.email", "t@t"]);
  writeFileSync(join(root, "README.md"), "x\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "init"]);
  return root;
}

test("repoId is stable across the repo and its linked worktree", () => {
  const root = initRepo();
  const handle = createTaskWorktree(root, "shared-id");
  assert.equal(repoId(handle.worktreePath), repoId(root));
  removeTaskWorktree(handle);
  rmSync(root, { recursive: true, force: true });
});

test("task worktrees live under bridge home, not the user repo", () => {
  const root = initRepo();
  const handle = createTaskWorktree(root, "outside");
  const normalized = handle.worktreePath.replaceAll("\\", "/");
  assert.match(normalized, /\/worktrees\/outside$/);
  assert.equal(normalized.startsWith(root.replaceAll("\\", "/")), false);
  assert.equal(existsSync(join(root, "agent-bridge")), false);
  assert.equal(existsSync(join(root, ".git")), true);
  removeTaskWorktree(handle);
  rmSync(root, { recursive: true, force: true });
});

test("ensureRepoDataDir copies legacy tasks.json once and does not write back", () => {
  const root = initRepo();
  const legacy = legacyDataDir(root);
  mkdirSync(legacy, { recursive: true });
  writeFileSync(
    join(legacy, "tasks.json"),
    `${JSON.stringify({ tasks: [{ taskId: "old", state: "RUNNING" }], byRequest: [], reviewHashes: [] })}\n`,
  );
  const dest = ensureRepoDataDir(root);
  assert.notEqual(dest, legacy);
  const copied = JSON.parse(readFileSync(join(dest, "tasks.json"), "utf8")) as { tasks: { state: string }[] };
  assert.equal(copied.tasks[0]?.state, "RUNNING");
  copied.tasks[0].state = "AWAITING_REVIEW";
  writeFileSync(join(dest, "tasks.json"), `${JSON.stringify(copied)}\n`);
  const leftover = JSON.parse(readFileSync(join(legacy, "tasks.json"), "utf8")) as { tasks: { state: string }[] };
  assert.equal(leftover.tasks[0]?.state, "RUNNING");
  assert.equal(ensureRepoDataDir(root), dest);
  const again = JSON.parse(readFileSync(join(dest, "tasks.json"), "utf8")) as { tasks: { state: string }[] };
  assert.equal(again.tasks[0]?.state, "AWAITING_REVIEW");
  rmSync(root, { recursive: true, force: true });
  rmSync(repoDataDir(root), { recursive: true, force: true });
});

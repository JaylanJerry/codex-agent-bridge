import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

function git(cwd: string, args: string[]): string {
  const proc = spawnSync("git", ["-c", "core.longpaths=true", ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  if (proc.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr || proc.stdout}`);
  }
  return (proc.stdout ?? "").trim();
}

export type WorktreeHandle = {
  repoPath: string;
  worktreePath: string;
  taskBranch: string;
  baseCommit: string;
};

export function createTaskWorktree(repoPath: string, taskId: string): WorktreeHandle {
  const abs = resolve(repoPath);
  const baseCommit = git(abs, ["rev-parse", "HEAD"]);
  const taskBranch = `agent-bridge/${taskId}`;
  const worktreePath = join(abs, "agent-bridge", taskId);
  mkdirSync(join(abs, "agent-bridge"), { recursive: true });
  if (existsSync(worktreePath)) {
    throw new Error(`worktree already exists: ${worktreePath}`);
  }
  git(abs, ["worktree", "add", worktreePath, "-b", taskBranch]);
  return { repoPath: abs, worktreePath, taskBranch, baseCommit };
}

export function removeTaskWorktree(handle: Pick<WorktreeHandle, "repoPath" | "worktreePath">): void {
  try {
    git(handle.repoPath, ["worktree", "remove", "--force", handle.worktreePath]);
  } catch {
    // already detached
  }
  if (existsSync(handle.worktreePath)) {
    rmSync(handle.worktreePath, { recursive: true, force: true });
  }
}

export function checkpointCommit(worktreePath: string, message: string): string {
  git(worktreePath, ["add", "-A"]);
  const staged = git(worktreePath, ["status", "--porcelain"]);
  if (!staged) {
    return git(worktreePath, ["rev-parse", "HEAD"]);
  }
  git(worktreePath, ["-c", "user.name=agent-bridge", "-c", "user.email=agent-bridge@localhost", "commit", "-m", message]);
  return git(worktreePath, ["rev-parse", "HEAD"]);
}

export function cherryPickToRepo(repoPath: string, commit: string): string {
  const abs = resolve(repoPath);
  const proc = spawnSync("git", ["-c", "core.longpaths=true", "cherry-pick", commit], {
    cwd: abs,
    encoding: "utf8",
    windowsHide: true,
  });
  if (proc.status !== 0) {
    spawnSync("git", ["-c", "core.longpaths=true", "cherry-pick", "--abort"], {
      cwd: abs,
      encoding: "utf8",
      windowsHide: true,
    });
    throw new Error(`cherry-pick failed: ${proc.stderr || proc.stdout}`);
  }
  return git(abs, ["rev-parse", "HEAD"]);
}

export function repoHead(repoPath: string): string {
  return git(resolve(repoPath), ["rev-parse", "HEAD"]);
}

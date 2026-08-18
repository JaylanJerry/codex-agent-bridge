import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
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

export function worktreeKey(path: string): string {
  const normalized = resolve(path).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function listAgentBridgeWorktrees(repoPath: string): string[] {
  const proc = spawnSync("git", ["-c", "core.longpaths=true", "worktree", "list", "--porcelain"], {
    cwd: resolve(repoPath),
    encoding: "utf8",
    windowsHide: true,
  });
  if (proc.status !== 0) return [];
  const paths: string[] = [];
  for (const line of proc.stdout.split(/\r?\n/)) {
    if (!line.startsWith("worktree ")) continue;
    const path = line.slice("worktree ".length);
    if (/[\\/]agent-bridge[\\/]/i.test(path)) paths.push(path);
  }
  return paths;
}

export function removeEmptyAgentBridgeDir(repoPath: string): void {
  const dir = join(resolve(repoPath), "agent-bridge");
  if (!existsSync(dir)) return;
  if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
}

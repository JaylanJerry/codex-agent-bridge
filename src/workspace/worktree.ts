import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { BridgeError, ErrorCodes } from "../core/errors.ts";

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
    const detail = `${proc.stderr || proc.stdout}`;
    spawnSync("git", ["-c", "core.longpaths=true", "cherry-pick", "--abort"], {
      cwd: abs,
      encoding: "utf8",
      windowsHide: true,
    });
    if (/now empty|previous cherry-pick is now empty|already applied/i.test(detail)) {
      return git(abs, ["rev-parse", "HEAD"]);
    }
    throw new Error(`cherry-pick failed: ${detail}`);
  }
  return git(abs, ["rev-parse", "HEAD"]);
}

export function repoHead(repoPath: string): string {
  return git(resolve(repoPath), ["rev-parse", "HEAD"]);
}

export function revParseOptional(cwd: string, rev: string): string | undefined {
  const proc = spawnSync("git", ["-c", "core.longpaths=true", "rev-parse", "--verify", rev], {
    cwd: resolve(cwd),
    encoding: "utf8",
    windowsHide: true,
  });
  if (proc.status !== 0) return undefined;
  return (proc.stdout ?? "").trim() || undefined;
}

export function isAncestor(repoPath: string, commit: string, head = "HEAD"): boolean {
  const proc = spawnSync(
    "git",
    ["-c", "core.longpaths=true", "merge-base", "--is-ancestor", commit, head],
    { cwd: resolve(repoPath), encoding: "utf8", windowsHide: true },
  );
  return proc.status === 0;
}

export function gitDir(repoPath: string): string {
  const proc = spawnSync("git", ["-c", "core.longpaths=true", "rev-parse", "--absolute-git-dir"], {
    cwd: resolve(repoPath),
    encoding: "utf8",
    windowsHide: true,
  });
  if (proc.status !== 0) return join(resolve(repoPath), ".git");
  return (proc.stdout ?? "").trim();
}

export function currentBranch(repoPath: string): string {
  return git(resolve(repoPath), ["rev-parse", "--abbrev-ref", "HEAD"]);
}

export function workingTreeDirty(repoPath: string): boolean {
  const proc = spawnSync("git", ["-c", "core.longpaths=true", "status", "--porcelain=v1", "-uall"], {
    cwd: resolve(repoPath),
    encoding: "utf8",
    windowsHide: true,
  });
  if (proc.status !== 0) {
    throw new Error(`git status failed: ${proc.stderr || proc.stdout}`);
  }
  const lines = (proc.stdout ?? "").split(/\r?\n/).filter(Boolean);
  return lines.some((line) => {
    const parsed = parseStatusPath(line);
    return parsed && !isBridgeOwnedPath(parsed);
  });
}

function parseStatusPath(line: string): string | undefined {
  if (line.length < 4) return undefined;
  let rest = line.slice(3);
  if (rest.includes(" -> ")) rest = rest.split(" -> ").pop() ?? rest;
  const trimmed = rest.trim().replace(/^"|"$/g, "");
  return trimmed.replaceAll("\\", "/");
}

function isBridgeOwnedPath(path: string): boolean {
  const normalized = path.replace(/^\.\//, "").replace(/\/$/, "");
  return (
    normalized === ".agent-bridge-data" ||
    normalized.startsWith(".agent-bridge-data/") ||
    normalized === "agent-bridge" ||
    normalized.startsWith("agent-bridge/") ||
    // Tests write journals at repo root; production journals live under .agent-bridge-data.
    normalized === "journal.ndjson"
  );
}

export type GitOperation =
  | "none"
  | "cherry-pick"
  | "merge"
  | "rebase"
  | "revert"
  | "bisect"
  | "sequencer";

export function inspectGitOperation(repoPath: string): GitOperation {
  const dir = gitDir(repoPath);
  if (existsSync(join(dir, "CHERRY_PICK_HEAD"))) return "cherry-pick";
  if (existsSync(join(dir, "MERGE_HEAD"))) return "merge";
  if (existsSync(join(dir, "REBASE_HEAD"))) return "rebase";
  if (existsSync(join(dir, "rebase-merge"))) return "rebase";
  if (existsSync(join(dir, "rebase-apply"))) return "rebase";
  if (existsSync(join(dir, "REVERT_HEAD"))) return "revert";
  if (existsSync(join(dir, "BISECT_LOG"))) return "bisect";
  if (existsSync(join(dir, "sequencer"))) return "sequencer";
  return "none";
}

export function assertTargetIdle(repoPath: string): void {
  const op = inspectGitOperation(repoPath);
  if (op !== "none") {
    throw new BridgeError(ErrorCodes.TARGET_REPO_BUSY, `git operation in progress: ${op}`);
  }
}

export function cherryPickInProgress(repoPath: string): boolean {
  const op = inspectGitOperation(repoPath);
  return op === "cherry-pick" || op === "sequencer";
}

export function abortCherryPick(repoPath: string): void {
  spawnSync("git", ["-c", "core.longpaths=true", "cherry-pick", "--abort"], {
    cwd: resolve(repoPath),
    encoding: "utf8",
    windowsHide: true,
  });
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

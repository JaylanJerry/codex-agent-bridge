import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { canonicalFsPath, gitSpawnEnv, isHomeTaskWorktreePath } from "../canonical-path.ts";
import { BridgeError, ErrorCodes } from "../core/errors.ts";
import { repoDataDir, taskWorktreePath } from "../persistence/layout.ts";

function git(cwd: string, args: string[]): string {
  const proc = spawnSync("git", ["-c", "core.longpaths=true", ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    env: gitSpawnEnv(),
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

export function createTaskWorktree(repoPath: string, taskId: string, startPoint?: string): WorktreeHandle {
  const abs = resolve(repoPath);
  const baseCommit = startPoint ? git(abs, ["rev-parse", startPoint]) : git(abs, ["rev-parse", "HEAD"]);
  const taskBranch = `agent-bridge/${taskId}`;
  const worktreePath = taskWorktreePath(abs, taskId);
  mkdirSync(dirname(worktreePath), { recursive: true });
  if (existsSync(worktreePath)) {
    throw new Error(`worktree already exists: ${worktreePath}`);
  }
  git(abs, ["worktree", "add", worktreePath, "-b", taskBranch, baseCommit]);
  return { repoPath: abs, worktreePath, taskBranch, baseCommit };
}

export function removeTaskWorktree(handle: Pick<WorktreeHandle, "repoPath" | "worktreePath">): void {
  const worktreePath = canonicalWorktreePath(handle.worktreePath);
  try {
    git(handle.repoPath, ["worktree", "remove", "--force", worktreePath]);
  } catch {
    // already detached
  }
  if (existsSync(worktreePath) || existsSync(handle.worktreePath)) {
    rmSync(existsSync(worktreePath) ? worktreePath : handle.worktreePath, { recursive: true, force: true });
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

export function checkpointFromTree(
  worktreePath: string,
  treeOid: string,
  baseCommit: string,
  taskBranch: string,
  message: string,
): string {
  const abs = resolve(worktreePath);
  const baseTree = git(abs, ["rev-parse", `${baseCommit}^{tree}`]);
  if (baseTree === treeOid) return baseCommit;
  const commit = git(abs, [
    "-c",
    "user.name=agent-bridge",
    "-c",
    "user.email=agent-bridge@localhost",
    "commit-tree",
    treeOid,
    "-p",
    baseCommit,
    "-m",
    message,
  ]);
  const ref = taskBranch ? `refs/heads/${taskBranch}` : "HEAD";
  const proc = spawnSync("git", ["-c", "core.longpaths=true", "update-ref", ref, commit, baseCommit], {
    cwd: abs,
    encoding: "utf8",
    windowsHide: true,
  });
  if (proc.status !== 0) {
    throw new BridgeError(
      ErrorCodes.WORKER_COMMITTED,
      `task branch moved; expected ${baseCommit}: ${proc.stderr || proc.stdout}`,
    );
  }
  return commit;
}

export function isCherryPickLanded(
  repoPath: string,
  preApplyHead: string,
  approvedCommit: string,
  head?: string,
): boolean {
  const abs = resolve(repoPath);
  const current = head ?? git(abs, ["rev-parse", "HEAD"]);
  if (current === preApplyHead) return false;
  const parent = revParseOptional(abs, `${current}^`);
  if (parent !== preApplyHead) return false;
  const headTree = git(abs, ["rev-parse", `${current}^{tree}`]);
  const approvedTree = git(abs, ["rev-parse", `${approvedCommit}^{tree}`]);
  return headTree === approvedTree;
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
    const op = inspectGitOperation(abs);
    if (op === "cherry-pick" || op === "sequencer") {
      const cherryHeadPath = join(gitDir(abs), "CHERRY_PICK_HEAD");
      const cherryHead = existsSync(cherryHeadPath) ? readFileSync(cherryHeadPath, "utf8").trim() : "";
      if (!cherryHead || cherryHead === commit || commit.startsWith(cherryHead) || cherryHead.startsWith(commit)) {
        abortCherryPick(abs);
      }
    }
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
    normalized.startsWith("agent-bridge/")
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

export function canonicalWorktreePath(path: string): string {
  return canonicalFsPath(path);
}

export function worktreeKey(path: string): string {
  const normalized = canonicalWorktreePath(path).replaceAll("\\", "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function agentBridgeWorktreeId(path: string): string | undefined {
  const match = /(?:^|\/)(?:agent-bridge|worktrees)\/([^/]+)\/?$/i.exec(
    canonicalWorktreePath(path).replaceAll("\\", "/"),
  );
  return match?.[1];
}

export function isProtectedAgentBridgeWorktree(
  path: string,
  protectedKeys: Set<string>,
  protectedTaskIds: Set<string>,
): boolean {
  if (protectedKeys.has(worktreeKey(path))) return true;
  const id = agentBridgeWorktreeId(path);
  if (!id) return false;
  return protectedTaskIds.has(id) || protectedTaskIds.has(id.toLowerCase());
}

export function listAgentBridgeWorktrees(repoPath: string): string[] {
  const proc = spawnSync("git", ["-c", "core.longpaths=true", "worktree", "list", "--porcelain"], {
    cwd: resolve(repoPath),
    encoding: "utf8",
    windowsHide: true,
    env: gitSpawnEnv(),
  });
  if (proc.status !== 0) return [];
  const homeWorktrees = worktreeKey(join(repoDataDir(repoPath), "worktrees"));
  const paths: string[] = [];
  for (const line of proc.stdout.split(/\r?\n/)) {
    if (!line.startsWith("worktree ")) continue;
    const path = line.slice("worktree ".length);
    const key = worktreeKey(path);
    const leftover = /[\\/]agent-bridge[\\/]/i.test(path);
    if (
      leftover ||
      isHomeTaskWorktreePath(path) ||
      key === homeWorktrees ||
      key.startsWith(`${homeWorktrees}/`)
    ) {
      paths.push(canonicalWorktreePath(path));
    }
  }
  return paths;
}

export function removeEmptyAgentBridgeDir(repoPath: string): void {
  const legacy = join(resolve(repoPath), "agent-bridge");
  if (existsSync(legacy) && readdirSync(legacy).length === 0) {
    rmSync(legacy, { recursive: true, force: true });
  }
  const worktrees = join(repoDataDir(repoPath), "worktrees");
  if (existsSync(worktrees) && readdirSync(worktrees).length === 0) {
    rmSync(worktrees, { recursive: true, force: true });
  }
}

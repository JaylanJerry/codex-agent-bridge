import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { bridgeHome } from "../paths.ts";

export const STORE_VERSION = 2;

function gitCommonDir(repoPath: string): string {
  const abs = resolve(repoPath);
  const proc = spawnSync("git", ["-c", "core.longpaths=true", "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: abs,
    encoding: "utf8",
    windowsHide: true,
  });
  let dir = (proc.stdout ?? "").trim();
  if (proc.status !== 0 || !dir) {
    const fallback = spawnSync("git", ["-c", "core.longpaths=true", "rev-parse", "--git-common-dir"], {
      cwd: abs,
      encoding: "utf8",
      windowsHide: true,
    });
    dir = (fallback.stdout ?? "").trim() || join(abs, ".git");
  }
  if (!isAbsolute(dir)) dir = resolve(abs, dir);
  try {
    return realpathSync(dir);
  } catch {
    return resolve(dir);
  }
}

export function repoId(repoPath: string): string {
  const common = gitCommonDir(repoPath).replaceAll("\\", "/").toLowerCase();
  return createHash("sha256").update(common).digest("hex").slice(0, 16);
}

export function repoDataDir(repoPath: string): string {
  return join(bridgeHome(), "repos", repoId(repoPath));
}

export function legacyDataDir(repoPath: string): string {
  return join(resolve(repoPath), ".agent-bridge-data");
}

export function existingRepoDataDir(repoPath: string): string | undefined {
  const dest = repoDataDir(repoPath);
  if (existsSync(dest)) return dest;
  const legacy = legacyDataDir(repoPath);
  if (existsSync(legacy)) return legacy;
  return undefined;
}

export function existingTasksPath(repoPath: string): string | undefined {
  const dest = join(repoDataDir(repoPath), "tasks.json");
  if (existsSync(dest)) return dest;
  const legacy = join(legacyDataDir(repoPath), "tasks.json");
  if (existsSync(legacy)) return legacy;
  return undefined;
}

export function taskWorktreePath(repoPath: string, taskId: string): string {
  return join(repoDataDir(repoPath), "worktrees", taskId);
}

export function ensureRepoDataDir(repoPath: string): string {
  const dest = repoDataDir(repoPath);
  mkdirSync(dest, { recursive: true });
  const destTasks = join(dest, "tasks.json");
  const legacy = legacyDataDir(repoPath);
  const legacyTasks = join(legacy, "tasks.json");
  if (!existsSync(destTasks) && existsSync(legacyTasks)) {
    copyFileSync(legacyTasks, destTasks);
    const journal = join(legacy, "journal.ndjson");
    const destJournal = join(dest, "journal.ndjson");
    if (existsSync(journal) && !existsSync(destJournal)) copyFileSync(journal, destJournal);
  }
  return dest;
}

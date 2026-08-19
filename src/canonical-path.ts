import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const HOME_TASK_WORKTREE = /\/repos\/[a-f0-9]{16}\/worktrees\/[^/]+\/?$/i;

/**
 * Git for Windows, when spawned from Git Bash (MSYSTEM set), prints POSIX
 * paths. `/d/foo` is drive D; `/tmp/foo` is Windows TEMP, not T:\mp\foo.
 */
export function canonicalFsPath(path: string): string {
  let s = path.trim().replace(/^"(.*)"$/, "$1");
  if (s.startsWith("\\\\?\\")) s = s.slice(4);
  else if (s.startsWith("//?/")) s = s.slice(4);
  if (process.platform === "win32") {
    if (s === "/tmp" || s.startsWith("/tmp/")) {
      const rest = s === "/tmp" ? "" : s.slice("/tmp/".length);
      s = rest ? join(tmpdir(), rest) : tmpdir();
    } else {
      const cyg = /^\/cygdrive\/([a-zA-Z])(?:\/(.*))?$/.exec(s);
      if (cyg) s = `${cyg[1]}:${cyg[2] ? `/${cyg[2]}` : "/"}`;
      else {
        const msys = /^\/([a-zA-Z])(\/.*)?$/.exec(s);
        if (msys) s = `${msys[1]}:${msys[2] ?? "/"}`;
      }
    }
  }
  const abs = resolve(s);
  try {
    return existsSync(abs) ? realpathSync(abs) : abs;
  } catch {
    return abs;
  }
}

export function gitSpawnEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env.MSYSTEM;
  delete env.MSYS;
  return env;
}

export function isHomeTaskWorktreePath(path: string): boolean {
  return HOME_TASK_WORKTREE.test(path.replaceAll("\\", "/")) || HOME_TASK_WORKTREE.test(canonicalFsPath(path).replaceAll("\\", "/"));
}

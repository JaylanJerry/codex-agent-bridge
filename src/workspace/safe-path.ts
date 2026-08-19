import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export class PathEscapeError extends Error {
  readonly code = "PATH_ESCAPE";

  constructor(detail: string) {
    super(`PATH_ESCAPE: ${detail}`);
    this.name = "PathEscapeError";
  }
}

function isAbsolutePath(input: string): boolean {
  const normalized = input.replaceAll("\\", "/");
  return isAbsolute(input) || isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized) || normalized.startsWith("/");
}

function samePathPrefix(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  if (!rel) return true;
  if (isAbsolute(rel)) return false;
  return !rel.split(/[/\\]/).includes("..") && !rel.startsWith(`..${sep}`) && rel !== "..";
}

function realIfExists(path: string): string {
  if (!existsSync(path)) return resolve(path);
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export function safeJoinWorktree(worktreePath: string, relativePath: string): string {
  if (!relativePath || relativePath.includes("\0")) {
    throw new PathEscapeError("empty or NUL path");
  }
  const posix = relativePath.replaceAll("\\", "/");
  if (isAbsolutePath(posix) || posix.startsWith("~/")) {
    throw new PathEscapeError(`absolute path rejected: ${relativePath}`);
  }
  const parts = posix.split("/").filter((part) => part !== ".");
  if (parts.length === 0 || parts.some((part) => part === ".." || part === "")) {
    throw new PathEscapeError(`path traversal rejected: ${relativePath}`);
  }

  const root = resolve(worktreePath);
  const target = resolve(root, parts.join("/"));
  if (!samePathPrefix(root, target)) {
    throw new PathEscapeError(`escapes worktree: ${relativePath}`);
  }

  const rootReal = realIfExists(root);
  let current = root;
  for (const part of parts) {
    current = resolve(current, part);
    if (!existsSync(current)) continue;
    try {
      const real = realpathSync(current);
      if (!samePathPrefix(rootReal, real)) {
        throw new PathEscapeError(`symlink escape: ${relativePath}`);
      }
    } catch (error) {
      if (error instanceof PathEscapeError) throw error;
    }
    try {
      if (lstatSync(current).isSymbolicLink()) {
        const real = realIfExists(current);
        if (!samePathPrefix(rootReal, real)) {
          throw new PathEscapeError(`symlink escape: ${relativePath}`);
        }
      }
    } catch (error) {
      if (error instanceof PathEscapeError) throw error;
    }
  }
  return target;
}

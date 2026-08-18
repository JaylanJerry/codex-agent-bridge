import { spawnSync } from "node:child_process";

export type ChangedFile = {
  path: string;
  change: "added" | "modified" | "deleted" | "renamed";
  oldPath?: string;
  tracked: boolean;
};

export type ChangeSet = {
  baseCommit: string;
  head: string;
  headEqualsBase: boolean;
  rangedDiffEmpty: boolean;
  files: ChangedFile[];
};

function git(cwd: string, args: string[]): string {
  const proc = spawnSync("git", ["-c", "core.longpaths=true", ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  if (proc.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr || proc.stdout}`);
  }
  // Do not trim leading whitespace: porcelain v1 uses a leading space in ` M path`.
  return (proc.stdout ?? "").replace(/(?:\r?\n)+$/, "");
}

function unquote(path: string): string {
  const trimmed = path.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return trimmed;
}

export function parsePorcelainLine(line: string): ChangedFile | undefined {
  if (!line) return undefined;
  const code = line.slice(0, 2);
  const rest = unquote(line.length >= 3 ? line.slice(3) : "");
  if (!rest && !code.includes("D")) return undefined;
  if (code.startsWith("R") || code.startsWith("C") || rest.includes(" -> ")) {
    const [oldPath, newPath] = rest.split(" -> ");
    return {
      path: unquote(newPath ?? rest),
      change: "renamed",
      oldPath: unquote(oldPath ?? rest),
      tracked: true,
    };
  }
  if (code.includes("D")) {
    return { path: rest, change: "deleted", tracked: true };
  }
  if (code === "??" || code.includes("A")) {
    return { path: rest, change: "added", tracked: code !== "??" };
  }
  return { path: rest, change: "modified", tracked: true };
}

export function collectChanges(cwd: string, baseCommit: string): ChangeSet {
  const head = git(cwd, ["rev-parse", "HEAD"]).trim();
  const ranged = git(cwd, ["diff", "--name-only", `${baseCommit}..HEAD`]).trim();
  const porcelain = git(cwd, ["status", "--porcelain=v1", "-uall"]);
  const files: ChangedFile[] = [];

  for (const line of porcelain.split(/\r?\n/)) {
    const file = parsePorcelainLine(line);
    if (file) files.push(file);
  }

  return {
    baseCommit,
    head,
    headEqualsBase: head === baseCommit,
    rangedDiffEmpty: ranged.length === 0,
    files,
  };
}

export function changeSetHash(changeSet: ChangeSet): string {
  const payload = changeSet.files
    .map((file) => `${file.change}:${file.path}:${file.oldPath ?? ""}`)
    .sort()
    .join("|");
  return `${changeSet.baseCommit}:${payload}`;
}

export function worktreeDiff(cwd: string, baseCommit: string): string {
  return git(cwd, ["diff", "--no-color", baseCommit]);
}

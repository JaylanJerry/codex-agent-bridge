import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parsePorcelainLine, type ChangedFile, type ChangeSet } from "../workspace/changes.ts";
import { safeJoinWorktree } from "../workspace/safe-path.ts";
import type { VerificationPlan, VerifyResult } from "../verification/runner.ts";

export type ReviewFile = ChangedFile & {
  mode?: string;
  symlinkTarget?: string;
  contentHash?: string;
};

export type ReviewSnapshot = {
  baseCommit: string;
  head: string;
  files: ReviewFile[];
  diff: string;
  verificationPlan: VerificationPlan | null;
  verificationResult: { passed: boolean; skipped: boolean; outputHash: string } | null;
  verifyConfigDrift: boolean;
};

function git(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const proc = spawnSync("git", ["-c", "core.longpaths=true", "-c", "core.quotepath=false", ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    status: proc.status ?? 1,
    stdout: proc.stdout ?? "",
    stderr: proc.stderr ?? "",
  };
}

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

export function reviewDigest(snapshot: ReviewSnapshot): string {
  const payload = {
    baseCommit: snapshot.baseCommit,
    head: snapshot.head,
    files: snapshot.files.map((file) => ({
      path: file.path.replaceAll("\\", "/"),
      change: file.change,
      oldPath: file.oldPath?.replaceAll("\\", "/") ?? "",
      mode: file.mode ?? "",
      symlinkTarget: file.symlinkTarget ?? "",
      contentHash: file.contentHash ?? "",
      tracked: file.tracked,
    })),
    verificationPlan: snapshot.verificationPlan,
    verificationResult: snapshot.verificationResult,
  };
  return sha256(JSON.stringify(canonicalize(payload)));
}

function gitMode(cwd: string, relativePath: string, change: ChangedFile["change"]): string | undefined {
  if (change === "deleted") {
    const staged = git(cwd, ["ls-tree", "-r", "--full-name", "HEAD", "--", relativePath]);
    const match = staged.stdout.match(/^(\d{6})\s/);
    if (match) return match[1];
    return undefined;
  }
  try {
    const abs = safeJoinWorktree(cwd, relativePath);
    if (!existsSync(abs)) return undefined;
    const stat = lstatSync(abs);
    if (stat.isSymbolicLink()) return "120000";
    if ((stat.mode & 0o111) !== 0) return "100755";
    return "100644";
  } catch {
    return undefined;
  }
}

function fileMeta(cwd: string, file: ChangedFile): ReviewFile {
  const path = file.path.replaceAll("\\", "/");
  const extra: ReviewFile = { ...file, path };
  extra.mode = gitMode(cwd, path, file.change);
  if (file.change === "deleted") return extra;
  try {
    const abs = safeJoinWorktree(cwd, path);
    if (!existsSync(abs)) return extra;
    const stat = lstatSync(abs);
    if (stat.isSymbolicLink()) {
      extra.symlinkTarget = readlinkSync(abs, "utf8");
      extra.contentHash = sha256(extra.symlinkTarget);
      return extra;
    }
    if (stat.isFile()) extra.contentHash = sha256(readFileSync(abs));
  } catch {
    // PATH_ESCAPE or vanished file: omit content; digest still binds path/change
  }
  return extra;
}

function newFilePatch(cwd: string, relativePath: string): string {
  try {
    const abs = safeJoinWorktree(cwd, relativePath);
    if (!existsSync(abs)) return "";
    const stat = lstatSync(abs);
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(abs, "utf8");
      return `diff --git a/${relativePath} b/${relativePath}\nnew file mode 120000\n--- /dev/null\n+++ b/${relativePath}\n@@ -0,0 +1 @@\n+${target}\n`;
    }
    const raw = readFileSync(abs);
    if (raw.includes(0)) {
      return `diff --git a/${relativePath} b/${relativePath}\nnew file mode 100644\nBinary files /dev/null and b/${relativePath} differ\n`;
    }
    const text = raw.toString("utf8");
    const lines = text.split("\n");
    const body = lines.map((line) => `+${line}`).join("\n");
    const plus = lines.length;
    return `diff --git a/${relativePath} b/${relativePath}\nnew file mode 100644\n--- /dev/null\n+++ b/${relativePath}\n@@ -0,0 +${plus} @@\n${body}${text.endsWith("\n") ? "" : "\n\\ No newline at end of file\n"}`;
  } catch {
    return "";
  }
}

function trackedDiff(cwd: string, baseCommit: string): string {
  const proc = git(cwd, ["diff", "--no-color", "--binary", baseCommit]);
  if (proc.status !== 0) return (proc.stdout || proc.stderr || "").replace(/(?:\r?\n)+$/, "");
  return proc.stdout.replace(/(?:\r?\n)+$/, "");
}

function worktreeVerifyHash(cwd: string): string | null {
  const path = join(cwd, ".agent-bridge", "verify.json");
  if (!existsSync(path)) return null;
  try {
    return sha256(readFileSync(path));
  } catch {
    return null;
  }
}

export function buildReviewSnapshot(opts: {
  cwd: string;
  baseCommit: string;
  verificationPlan?: VerificationPlan | null;
  verificationResult?: VerifyResult | null;
}): ReviewSnapshot {
  const headProc = git(opts.cwd, ["rev-parse", "HEAD"]);
  if (headProc.status !== 0) throw new Error(headProc.stderr || "rev-parse HEAD failed");
  const head = headProc.stdout.trim();
  const porcelain = git(opts.cwd, ["status", "--porcelain=v1", "-uall"]);
  const files: ReviewFile[] = [];
  for (const line of porcelain.stdout.split(/\r?\n/)) {
    const parsed = parsePorcelainLine(line);
    if (parsed) files.push(fileMeta(opts.cwd, parsed));
  }
  files.sort((a, b) => a.path.localeCompare(b.path));

  const parts = [trackedDiff(opts.cwd, opts.baseCommit)];
  for (const file of files) {
    if (file.change === "added" && !file.tracked) {
      const patch = newFilePatch(opts.cwd, file.path);
      if (patch) parts.push(patch);
    }
  }
  const diff = parts.filter(Boolean).join("\n");

  const plan = opts.verificationPlan ?? null;
  const planHash = plan ? sha256(JSON.stringify(canonicalize(plan))) : null;
  const worktreeHash = worktreeVerifyHash(opts.cwd);
  const verifyConfigDrift = Boolean(planHash && worktreeHash && planHash !== worktreeHash);

  const verificationResult = opts.verificationResult
    ? {
        passed: opts.verificationResult.passed,
        skipped: opts.verificationResult.skipped,
        outputHash: sha256(opts.verificationResult.output ?? ""),
      }
    : null;

  return {
    baseCommit: opts.baseCommit,
    head,
    files,
    diff,
    verificationPlan: plan,
    verificationResult,
    verifyConfigDrift,
  };
}

export function snapshotToChangeSet(snapshot: ReviewSnapshot): ChangeSet {
  return {
    baseCommit: snapshot.baseCommit,
    head: snapshot.head,
    headEqualsBase: snapshot.head === snapshot.baseCommit,
    rangedDiffEmpty: snapshot.head === snapshot.baseCommit,
    files: snapshot.files,
  };
}

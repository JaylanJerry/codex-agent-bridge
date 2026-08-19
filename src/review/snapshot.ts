import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import type { ChangedFile, ChangeSet } from "../workspace/changes.ts";
import { BridgeError, ErrorCodes } from "../core/errors.ts";
import { parseVerificationPlan, type VerificationPlan, type VerifyResult } from "../verification/runner.ts";

export type ReviewFile = ChangedFile & {
  mode?: string;
};

export type ReviewSnapshot = {
  baseCommit: string;
  head: string;
  resultTreeOid: string;
  canonicalDiffHash: string;
  files: ReviewFile[];
  diff: string;
  verifyIds: string[];
  verificationPlan: VerificationPlan | null;
  verificationResult: { passed: boolean; skipped: boolean; outputHash: string } | null;
  verifyConfigDrift: boolean;
};

function git(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): { status: number; stdout: string; stderr: string } {
  const proc = spawnSync("git", ["-c", "core.longpaths=true", "-c", "core.quotepath=false", ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    env: env ? { ...process.env, ...env } : process.env,
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

export function canonicalize(value: unknown): unknown {
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
    resultTreeOid: snapshot.resultTreeOid,
    canonicalDiffHash: snapshot.canonicalDiffHash,
    verifyIds: [...snapshot.verifyIds].sort(),
    verificationPlan: snapshot.verificationPlan,
    verificationResult: snapshot.verificationResult,
  };
  return sha256(JSON.stringify(canonicalize(payload)));
}

export function writeWorktreeResultTree(cwd: string, baseCommit: string): string {
  const headBefore = git(cwd, ["rev-parse", "HEAD"]);
  if (headBefore.status !== 0) throw new Error(headBefore.stderr || "rev-parse HEAD failed");
  const head = headBefore.stdout.trim();
  if (head !== baseCommit) {
    throw new BridgeError(
      ErrorCodes.WORKER_COMMITTED,
      "Worker committed in the worktree; V1 does not support Worker commits",
    );
  }
  const indexPath = join(tmpdir(), `ab-review-${randomUUID()}.index`);
  const env = { GIT_INDEX_FILE: indexPath };
  try {
    const read = git(cwd, ["read-tree", baseCommit], env);
    if (read.status !== 0) throw new Error(read.stderr || "git read-tree baseCommit failed");
    const add = git(cwd, ["add", "-A"], env);
    if (add.status !== 0) throw new Error(add.stderr || "git add -A failed");
    const written = git(cwd, ["write-tree"], env);
    if (written.status !== 0) throw new Error(written.stderr || "git write-tree failed");
    const headAfter = git(cwd, ["rev-parse", "HEAD"]);
    if (headAfter.status !== 0) throw new Error(headAfter.stderr || "rev-parse HEAD failed");
    if (headAfter.stdout.trim() !== baseCommit) {
      throw new BridgeError(
        ErrorCodes.WORKER_COMMITTED,
        "Worker committed in the worktree; V1 does not support Worker commits",
      );
    }
    return written.stdout.trim();
  } finally {
    rmSync(indexPath, { force: true });
    rmSync(`${indexPath}.lock`, { force: true });
  }
}

export function parseDiffRawZ(raw: string): ReviewFile[] {
  const parts = raw.split("\0");
  const files: ReviewFile[] = [];
  let i = 0;
  while (i < parts.length) {
    const meta = parts[i];
    if (!meta) {
      i += 1;
      continue;
    }
    const match = meta.match(/^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z](?:\d+)?)$/);
    if (!match) {
      i += 1;
      continue;
    }
    const [, srcMode, dstMode, , , status] = match;
    if (srcMode === "160000" || dstMode === "160000") {
      throw new BridgeError(ErrorCodes.GITLINK_NOT_SUPPORTED, "submodule/gitlink changes are not supported");
    }
    if (status.startsWith("R") || status.startsWith("C")) {
      const oldPath = parts[i + 1];
      const newPath = parts[i + 2];
      if (!oldPath || !newPath) throw new Error("truncated rename in git diff --raw -z");
      files.push({
        path: newPath.replaceAll("\\", "/"),
        oldPath: oldPath.replaceAll("\\", "/"),
        change: "renamed",
        tracked: true,
        mode: dstMode,
      });
      i += 3;
      continue;
    }
    const path = parts[i + 1];
    if (!path) throw new Error("truncated path in git diff --raw -z");
    const change: ReviewFile["change"] = status.startsWith("A")
      ? "added"
      : status.startsWith("D")
        ? "deleted"
        : "modified";
    files.push({
      path: path.replaceAll("\\", "/"),
      change,
      tracked: true,
      mode: change === "deleted" ? srcMode : dstMode,
    });
    i += 2;
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

function detectVerifyConfigDrift(cwd: string, plan: VerificationPlan | null): boolean {
  const path = join(cwd, ".agent-bridge", "verify.json");
  if (!existsSync(path)) return plan !== null;
  try {
    const parsed = parseVerificationPlan(readFileSync(path, "utf8"));
    return JSON.stringify(canonicalize(parsed)) !== JSON.stringify(canonicalize(plan));
  } catch {
    return true;
  }
}

export function buildReviewSnapshot(opts: {
  cwd: string;
  baseCommit: string;
  verifyIds?: string[];
  verificationPlan?: VerificationPlan | null;
  verificationResult?: VerifyResult | null;
}): ReviewSnapshot {
  const headProc = git(opts.cwd, ["rev-parse", "HEAD"]);
  if (headProc.status !== 0) throw new Error(headProc.stderr || "rev-parse HEAD failed");
  const head = headProc.stdout.trim();
  if (head !== opts.baseCommit) {
    throw new BridgeError(
      ErrorCodes.WORKER_COMMITTED,
      "Worker committed in the worktree; V1 does not support Worker commits",
    );
  }
  const resultTreeOid = writeWorktreeResultTree(opts.cwd, opts.baseCommit);
  const headAfter = git(opts.cwd, ["rev-parse", "HEAD"]);
  if (headAfter.status !== 0 || headAfter.stdout.trim() !== opts.baseCommit) {
    throw new BridgeError(
      ErrorCodes.WORKER_COMMITTED,
      "Worker committed in the worktree; V1 does not support Worker commits",
    );
  }

  const raw = git(opts.cwd, ["diff-tree", "-r", "--raw", "-z", "--no-commit-id", opts.baseCommit, resultTreeOid]);
  if (raw.status !== 0) throw new Error(raw.stderr || "git diff-tree --raw failed");
  const files = parseDiffRawZ(raw.stdout);

  const diffProc = git(opts.cwd, ["diff", "--binary", "--no-color", opts.baseCommit, resultTreeOid]);
  if (diffProc.status !== 0) throw new Error(diffProc.stderr || "git diff --binary failed");
  const diff = diffProc.stdout.replace(/(?:\r?\n)+$/, "");

  const plan = opts.verificationPlan ?? null;
  const verifyIds = opts.verifyIds ?? [];
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
    resultTreeOid,
    canonicalDiffHash: sha256(diff),
    files,
    diff,
    verifyIds,
    verificationPlan: plan,
    verificationResult,
    verifyConfigDrift: detectVerifyConfigDrift(opts.cwd, plan),
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

import type { ChangeSet } from "../workspace/changes.ts";
import type { ReviewSnapshot } from "./snapshot.ts";

export type ReviewPacket = {
  objective: string;
  acceptanceCriteria: { id: string; text: string }[];
  workerStopReason?: string;
  verification?: { passed: boolean; output?: string };
  diffstat: { files: number; added: number; deleted: number; renamed: number };
  changedFiles: { path: string; change: string }[];
  warnings: string[];
  digest: string;
  diff: string;
};

export function buildReviewPacket(input: {
  objective: string;
  acceptanceCriteria?: { id: string; text: string }[];
  workerStopReason?: string;
  verification?: { passed: boolean; output?: string };
  changeSet: ChangeSet;
  snapshot: ReviewSnapshot;
  digest: string;
}): ReviewPacket {
  const files = input.snapshot.files;
  const warnings: string[] = [];
  if (input.snapshot.head !== input.snapshot.baseCommit) {
    warnings.push("WORKER_COMMITTED: HEAD moved; Worker must not commit");
  }
  if (input.verification && !input.verification.passed) {
    warnings.push("verification failed");
  }
  if (input.snapshot.verifyConfigDrift) {
    warnings.push("Worker modified verification config; Bridge will not use the worktree copy");
  }
  return {
    objective: input.objective,
    acceptanceCriteria: input.acceptanceCriteria ?? [],
    workerStopReason: input.workerStopReason,
    verification: input.verification,
    diffstat: {
      files: files.length,
      added: files.filter((file) => file.change === "added").length,
      deleted: files.filter((file) => file.change === "deleted").length,
      renamed: files.filter((file) => file.change === "renamed").length,
    },
    changedFiles: files.map((file) => ({ path: file.path, change: file.change })),
    warnings,
    digest: input.digest,
    diff: input.snapshot.diff,
  };
}

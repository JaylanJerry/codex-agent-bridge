import type { ChangeSet } from "../workspace/changes.ts";

export type ReviewPacket = {
  objective: string;
  acceptanceCriteria: { id: string; text: string }[];
  workerStopReason?: string;
  verification?: { passed: boolean; output?: string };
  diffstat: { files: number; added: number; deleted: number; renamed: number };
  changedFiles: { path: string; change: string }[];
  warnings: string[];
};

export function buildReviewPacket(input: {
  objective: string;
  acceptanceCriteria?: { id: string; text: string }[];
  workerStopReason?: string;
  verification?: { passed: boolean; output?: string };
  changeSet: ChangeSet;
}): ReviewPacket {
  const files = input.changeSet.files;
  const warnings: string[] = [];
  if (!input.changeSet.headEqualsBase && !input.changeSet.rangedDiffEmpty) {
    warnings.push("HEAD moved; Worker may have committed");
  }
  if (input.verification && !input.verification.passed) {
    warnings.push("verification failed");
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
  };
}

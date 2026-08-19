import type { PermissionMode } from "../runtime/contract.ts";

export type TaskState =
  | "QUEUED"
  | "STARTING"
  | "RUNNING"
  | "WAITING_FOR_INPUT"
  | "VERIFYING"
  | "AWAITING_REVIEW"
  | "FINALIZING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "TASK_TIMED_OUT";

export type Verdict = "APPROVED" | "NEEDS_REVISION" | "REJECTED" | null;

export type BridgeTaskInput = {
  schemaVersion: "1.2";
  clientRequestId: string;
  objective: string;
  context?: string;
  projectPath: string;
  workerId: string;
  isolation?: { mode: "worktree" | "in-place"; baseRef?: string };
  constraints?: string[];
  acceptanceCriteria?: { id: string; text: string }[];
  verification?: { enabled: boolean; verifyIds: string[] };
  permissionMode?: PermissionMode;
};

export type ApplicationRecord = {
  operationId: string;
  taskId: string;
  approvedCommit: string;
  targetBranch: string;
  preApplyHead: string;
  landedHead?: string;
  state: "CLAIMED" | "APPLIED";
};

export type TaskRecord = {
  taskId: string;
  clientRequestId: string;
  state: TaskState;
  stateVersion: number;
  verdict: Verdict;
  interrupted: boolean;
  workerPid?: number;
  worktreePath?: string;
  taskBranch?: string;
  baseCommit?: string;
  approvedCommit?: string;
  appliedHead?: string;
  lastStopReason?: string;
  lastVerification?: { passed: boolean; output: string; skipped: boolean };
  reviewDigest?: string;
  reviewTreeOid?: string;
  targetBranch?: string;
  expectedTargetHead?: string;
  verificationPlan?: {
    schemaVersion?: string;
    commands: Record<string, { exe: string; args: string[]; timeoutMs?: number }>;
  };
  sessionId?: string;
  sessionResumed?: boolean;
  objective: string;
  projectPath: string;
  workerId: string;
  reviewNotes?: string;
  acceptanceCriteria?: { id: string; text: string }[];
  verification?: { enabled: boolean; verifyIds: string[] };
  pendingInput?: {
    kind: "permission";
    sessionId: string;
    title?: string;
    options: { optionId: string; kind: string; name: string }[];
  };
  permissionMode?: PermissionMode;
  application?: ApplicationRecord;
};

const allowed: Record<TaskState, TaskState[]> = {
  QUEUED: ["STARTING", "CANCELLED", "AWAITING_REVIEW"],
  STARTING: ["RUNNING", "FAILED", "CANCELLED", "TASK_TIMED_OUT", "AWAITING_REVIEW"],
  RUNNING: ["WAITING_FOR_INPUT", "VERIFYING", "AWAITING_REVIEW", "FAILED", "CANCELLED", "TASK_TIMED_OUT"],
  WAITING_FOR_INPUT: ["RUNNING", "AWAITING_REVIEW", "FAILED", "CANCELLED", "TASK_TIMED_OUT"],
  VERIFYING: ["AWAITING_REVIEW", "FAILED", "TASK_TIMED_OUT"],
  AWAITING_REVIEW: ["RUNNING", "FINALIZING", "FAILED", "CANCELLED"],
  FINALIZING: ["COMPLETED", "FAILED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  TASK_TIMED_OUT: ["RUNNING", "FAILED", "CANCELLED"],
};

export function transition(current: TaskState, next: TaskState): TaskState {
  if (!allowed[current].includes(next)) {
    throw new Error(`illegal state transition ${current} -> ${next}`);
  }
  return next;
}

export function isTerminalState(state: TaskState): boolean {
  return state === "COMPLETED" || state === "FAILED" || state === "CANCELLED";
}

export function needsAttention(task: TaskRecord): boolean {
  if (task.state === "CANCELLED" || task.state === "COMPLETED") return false;
  return (
    task.interrupted ||
    task.state === "AWAITING_REVIEW" ||
    task.state === "WAITING_FOR_INPUT" ||
    task.state === "FINALIZING" ||
    task.state === "FAILED" ||
    task.state === "TASK_TIMED_OUT"
  );
}

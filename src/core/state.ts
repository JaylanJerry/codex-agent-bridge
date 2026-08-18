export type TaskState =
  | "QUEUED"
  | "STARTING"
  | "RUNNING"
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
  objective: string;
  projectPath: string;
  workerId: string;
  reviewNotes?: string;
  acceptanceCriteria?: { id: string; text: string }[];
  verification?: { enabled: boolean; verifyIds: string[] };
};

const allowed: Record<TaskState, TaskState[]> = {
  QUEUED: ["STARTING", "CANCELLED"],
  STARTING: ["RUNNING", "FAILED", "CANCELLED"],
  RUNNING: ["VERIFYING", "AWAITING_REVIEW", "FAILED", "CANCELLED", "TASK_TIMED_OUT"],
  VERIFYING: ["AWAITING_REVIEW", "FAILED"],
  AWAITING_REVIEW: ["RUNNING", "FINALIZING", "FAILED", "CANCELLED"],
  FINALIZING: ["COMPLETED", "FAILED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  TASK_TIMED_OUT: [],
};

export function transition(current: TaskState, next: TaskState): TaskState {
  if (!allowed[current].includes(next)) {
    throw new Error(`illegal state transition ${current} -> ${next}`);
  }
  return next;
}

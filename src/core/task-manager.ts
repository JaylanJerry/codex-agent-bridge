import { randomUUID } from "node:crypto";
import { needsAttention, transition, type BridgeTaskInput, type TaskRecord } from "./state.ts";
import { Journal } from "../persistence/journal.ts";
import type { TaskSnapshot } from "../persistence/store.ts";
import {
  checkpointCommit,
  cherryPickToRepo,
  createTaskWorktree,
  removeTaskWorktree,
  repoHead,
  type WorktreeHandle,
} from "../workspace/worktree.ts";
import { changeSetHash, collectChanges, worktreeDiff } from "../workspace/changes.ts";
import { buildReviewPacket, type ReviewPacket } from "../review/packet.ts";
import { listVerifyIds, runVerification } from "../verification/runner.ts";
import type { RuntimeDriver, WorkerProfile } from "../runtime/contract.ts";

export class TaskAlreadyExistsError extends Error {
  constructor(public readonly taskId: string) {
    super(`TASK_ALREADY_EXISTS:${taskId}`);
    this.name = "TaskAlreadyExistsError";
  }
}

export class StateVersionConflictError extends Error {
  constructor() {
    super("STATE_VERSION_CONFLICT");
    this.name = "StateVersionConflictError";
  }
}

export class TaskManager {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly byRequest = new Map<string, string>();
  private readonly worktrees = new Map<string, WorktreeHandle>();
  private readonly sessions = new Map<string, { profile: WorkerProfile; sessionId: string }>();
  private readonly reviewHashes = new Map<string, string>();
  private readonly turns = new Map<string, Promise<void>>();

  constructor(
    private readonly drivers: Map<string, RuntimeDriver>,
    private readonly profiles: Map<string, WorkerProfile>,
    private readonly journal: Journal,
  ) {}

  hydrate(snapshot: TaskSnapshot): void {
    this.tasks.clear();
    this.byRequest.clear();
    this.reviewHashes.clear();
    this.worktrees.clear();
    this.sessions.clear();
    for (const task of snapshot.tasks) this.tasks.set(task.taskId, { ...task });
    for (const [requestId, taskId] of snapshot.byRequest) this.byRequest.set(requestId, taskId);
    for (const [taskId, hash] of snapshot.reviewHashes) this.reviewHashes.set(taskId, hash);
  }

  snapshot(): TaskSnapshot {
    return {
      tasks: [...this.tasks.values()].map((task) => ({ ...task })),
      byRequest: [...this.byRequest.entries()],
      reviewHashes: [...this.reviewHashes.entries()],
    };
  }

  run(input: BridgeTaskInput): TaskRecord {
    const existing = this.byRequest.get(input.clientRequestId);
    if (existing) {
      const task = this.require(existing);
      if (task.objective !== input.objective || task.projectPath !== input.projectPath) {
        throw new TaskAlreadyExistsError(existing);
      }
      return task;
    }
    const profile = this.profiles.get(input.workerId);
    if (!profile) throw new Error(`unknown worker ${input.workerId}`);
    const driver = this.drivers.get(profile.preferredRuntime);
    if (!driver) throw new Error(`no driver for ${profile.preferredRuntime}`);

    const taskId = randomUUID();
    const isolation = input.isolation?.mode ?? "worktree";
    const worktree =
      isolation === "worktree" ? createTaskWorktree(input.projectPath, taskId) : undefined;
    const worktreePath = worktree?.worktreePath ?? input.projectPath;
    if (worktree) this.worktrees.set(taskId, worktree);

    const task: TaskRecord = {
      taskId,
      clientRequestId: input.clientRequestId,
      state: "QUEUED",
      stateVersion: 1,
      verdict: null,
      interrupted: false,
      worktreePath,
      taskBranch: worktree?.taskBranch,
      baseCommit: worktree?.baseCommit,
      objective: input.objective,
      projectPath: input.projectPath,
      workerId: input.workerId,
      acceptanceCriteria: input.acceptanceCriteria,
      verification: resolveVerification(input, worktreePath),
    };
    this.tasks.set(taskId, task);
    this.byRequest.set(input.clientRequestId, taskId);
    this.journal.append("run", input, taskId);

    this.setState(task, "STARTING");
    return this.startTurn(task, input.objective, input);
  }

  private startTurn(task: TaskRecord, text: string, input?: BridgeTaskInput): TaskRecord {
    const profile = this.profiles.get(task.workerId)!;
    const driver = this.drivers.get(profile.preferredRuntime)!;
    if (task.state !== "RUNNING") this.setState(task, "RUNNING");
    const pending = this.runTurn(task, profile, driver, text, input);
    this.turns.set(task.taskId, pending);
    void pending.finally(() => {
      if (this.turns.get(task.taskId) === pending) this.turns.delete(task.taskId);
    });
    return task;
  }

  private settled(task: TaskRecord): boolean {
    return ["AWAITING_REVIEW", "COMPLETED", "FAILED", "CANCELLED", "TASK_TIMED_OUT"].includes(
      task.state,
    );
  }

  private shouldAbortTurn(task: TaskRecord): boolean {
    return task.interrupted || this.settled(task);
  }

  private async runTurn(
    task: TaskRecord,
    profile: WorkerProfile,
    driver: RuntimeDriver,
    text: string,
    input?: BridgeTaskInput,
  ): Promise<void> {
    try {
      let session = this.sessions.get(task.taskId);
      if (!session) {
        const previousSessionId = task.sessionId;
        const started = await driver.start(profile, task.worktreePath ?? task.projectPath, {
          resumeSessionId: previousSessionId,
        });
        if (this.shouldAbortTurn(task)) {
          await driver.close(started).catch(() => undefined);
          return;
        }
        session = { profile, sessionId: started.id };
        this.sessions.set(task.taskId, session);
        task.sessionId = started.id;
        task.sessionResumed = Boolean(started.resumed);
        task.workerPid = started.pid;
        this.journal.append(
          "session-created",
          {
            sessionId: started.id,
            pid: started.pid,
            resumed: Boolean(started.resumed),
            resumeAttempted: Boolean(previousSessionId) && !started.resumed,
          },
          task.taskId,
        );
      }
      const result = await driver.sendTurn(
        {
          id: session.sessionId,
          profileId: profile.id,
          worktreePath: task.worktreePath ?? task.projectPath,
        },
        { sessionId: session.sessionId, text },
      );
      if (this.shouldAbortTurn(task)) return;
      task.lastStopReason = result.stopReason;
      this.journal.append("worker-turn-finished", result, task.taskId);
      const verifyIds = task.verification?.enabled ? task.verification.verifyIds : [];
      if (verifyIds.length > 0) {
        this.setState(task, "VERIFYING");
        const verification = runVerification(task.worktreePath ?? task.projectPath, verifyIds);
        task.lastVerification = verification;
        this.journal.append("verification-result", verification, task.taskId);
      }
      if (this.shouldAbortTurn(task)) return;
      this.setState(task, "AWAITING_REVIEW");
    } catch (error) {
      if (this.shouldAbortTurn(task)) return;
      task.interrupted = true;
      this.setState(task, "FAILED");
      this.journal.append("failed", { error: String(error) }, task.taskId);
    }
  }

  async wait(taskId: string, timeoutMs = 900_000): Promise<TaskRecord> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const task = this.require(taskId);
      if (this.settled(task)) return task;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`wait timed out for ${taskId}`);
  }

  reviewPacket(taskId: string): ReviewPacket {
    const task = this.require(taskId);
    const changeSet = collectChanges(task.worktreePath ?? task.projectPath, task.baseCommit ?? "");
    this.reviewHashes.set(taskId, changeSetHash(changeSet));
    return buildReviewPacket({
      objective: task.objective,
      acceptanceCriteria: task.acceptanceCriteria,
      workerStopReason: task.lastStopReason,
      verification: task.lastVerification,
      changeSet,
    });
  }

  diff(taskId: string): string {
    const task = this.require(taskId);
    return worktreeDiff(task.worktreePath ?? task.projectPath, task.baseCommit ?? "HEAD");
  }

  continue(taskId: string, notes: string, expectedStateVersion: number): TaskRecord {
    const task = this.require(taskId);
    this.assertVersion(task, expectedStateVersion);
    if (task.state !== "AWAITING_REVIEW") throw new Error("continue requires AWAITING_REVIEW");
    task.verdict = "NEEDS_REVISION";
    task.reviewNotes = notes;
    this.setState(task, "RUNNING");
    this.startTurn(task, notes);
    return task;
  }

  approve(taskId: string, expectedStateVersion: number): TaskRecord {
    const task = this.require(taskId);
    this.assertVersion(task, expectedStateVersion);
    if (task.state !== "AWAITING_REVIEW") throw new Error("approve requires AWAITING_REVIEW");
    const changeSet = collectChanges(task.worktreePath ?? task.projectPath, task.baseCommit ?? "");
    const current = changeSetHash(changeSet);
    const expected = this.reviewHashes.get(taskId);
    if (expected && expected !== current) {
      throw new Error("review drift: ChangeSet changed after review");
    }
    this.setState(task, "FINALIZING");
    task.verdict = "APPROVED";
    if (task.worktreePath) {
      task.approvedCommit = checkpointCommit(
        task.worktreePath,
        `checkpoint: ${task.taskId}`,
      );
    }
    this.setState(task, "COMPLETED");
    this.cleanupWorktree(task);
    return task;
  }

  apply(taskId: string, expectedStateVersion: number): TaskRecord {
    const task = this.require(taskId);
    this.assertVersion(task, expectedStateVersion);
    if (task.state !== "COMPLETED" || task.verdict !== "APPROVED" || !task.approvedCommit) {
      throw new Error("apply requires an approved checkpoint");
    }
    const head = repoHead(task.projectPath);
    if (task.appliedHead && task.appliedHead === head) return task;
    task.appliedHead = cherryPickToRepo(task.projectPath, task.approvedCommit);
    this.journal.append("applied", { head: task.appliedHead, commit: task.approvedCommit }, task.taskId);
    return task;
  }

  reject(taskId: string, expectedStateVersion: number): TaskRecord {
    const task = this.require(taskId);
    this.assertVersion(task, expectedStateVersion);
    task.verdict = "REJECTED";
    this.setState(task, "FAILED");
    this.cleanupWorktree(task);
    return task;
  }

  async cancel(taskId: string, expectedStateVersion: number): Promise<TaskRecord> {
    const task = this.require(taskId);
    this.assertVersion(task, expectedStateVersion);
    task.interrupted = true;
    const session = this.sessions.get(taskId);
    if (session) {
      const driver = this.drivers.get(session.profile.preferredRuntime);
      await driver?.cancel({
        id: session.sessionId,
        profileId: session.profile.id,
        worktreePath: task.worktreePath ?? task.projectPath,
      });
    }
    if (!["COMPLETED", "FAILED", "CANCELLED"].includes(task.state)) {
      this.setState(task, "CANCELLED");
    }
    this.cleanupWorktree(task);
    return task;
  }

  recoverInterrupted(taskId: string, workerPid?: number): TaskRecord {
    const task = this.require(taskId);
    task.workerPid = workerPid;
    task.interrupted = true;
    if (["RUNNING", "STARTING", "VERIFYING"].includes(task.state)) {
      this.setState(task, "AWAITING_REVIEW");
    }
    return task;
  }

  async drain(taskId: string): Promise<void> {
    await this.turns.get(taskId);
  }

  get(taskId: string): TaskRecord {
    return this.require(taskId);
  }

  list(filter?: { needsAttention?: boolean }): TaskRecord[] {
    const tasks = [...this.tasks.values()];
    if (filter?.needsAttention) return tasks.filter(needsAttention);
    return tasks;
  }

  private cleanupWorktree(task: TaskRecord): void {
    if (!task.worktreePath || task.worktreePath === task.projectPath) return;
    try {
      removeTaskWorktree({ repoPath: task.projectPath, worktreePath: task.worktreePath });
    } catch (error) {
      this.journal.append("worktree-cleanup-failed", { error: String(error) }, task.taskId);
    }
    task.worktreePath = undefined;
  }

  private require(taskId: string): TaskRecord {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`unknown task ${taskId}`);
    return task;
  }

  private assertVersion(task: TaskRecord, expected: number): void {
    if (task.stateVersion !== expected) throw new StateVersionConflictError();
  }

  private setState(task: TaskRecord, next: TaskRecord["state"]): void {
    task.state = transition(task.state, next);
    task.stateVersion += 1;
    this.journal.append("state-changed", { state: task.state, stateVersion: task.stateVersion }, task.taskId);
  }
}

function resolveVerification(
  input: BridgeTaskInput,
  worktreePath: string,
): BridgeTaskInput["verification"] {
  if (input.verification) return input.verification;
  const ids = listVerifyIds(worktreePath);
  if (ids.length === 0) return undefined;
  return { enabled: true, verifyIds: ids };
}

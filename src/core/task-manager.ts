import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isTerminalState, needsAttention, transition, type BridgeTaskInput, type TaskRecord } from "./state.ts";
import { Journal } from "../persistence/journal.ts";
import type { TaskSnapshot } from "../persistence/store.ts";
import { BridgeError, ErrorCodes } from "./errors.ts";
import {
  assertTargetIdle,
  checkpointFromTree,
  cherryPickToRepo,
  createTaskWorktree,
  currentBranch,
  isProtectedAgentBridgeWorktree,
  listAgentBridgeWorktrees,
  removeEmptyAgentBridgeDir,
  removeTaskWorktree,
  repoHead,
  workingTreeDirty,
  worktreeKey,
  type WorktreeHandle,
} from "../workspace/worktree.ts";
import { buildReviewSnapshot, reviewDigest, snapshotToChangeSet } from "../review/snapshot.ts";
import { buildReviewPacket, type ReviewPacket } from "../review/packet.ts";
import { listVerifyIds, loadVerificationPlanFromCommit, runVerification } from "../verification/runner.ts";
import type { PermissionMode, PermissionOutcome, RuntimeDriver, WorkerProfile } from "../runtime/contract.ts";
import { autoSelectPermission } from "../runtime/contract.ts";
import { assertExecutableWorker, assertInPlaceAllowed, debugWorkersAllowed } from "../workers/debug.ts";

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
  private readonly permissionResolvers = new Map<string, (outcome: PermissionOutcome) => void>();
  private readonly turnEpoch = new Map<string, number>();
  private readonly mutating = new Set<string>();
  private permissionMode: PermissionMode = "auto";

  private persistHook: (() => void) | undefined;

  constructor(
    private readonly drivers: Map<string, RuntimeDriver>,
    private readonly profiles: Map<string, WorkerProfile>,
    private readonly journal: Journal,
    private readonly debugWorkers: () => boolean = debugWorkersAllowed,
  ) {}

  setPersist(hook: () => void): void {
    this.persistHook = hook;
  }

  private persist(): void {
    this.persistHook?.();
  }

  hydrate(snapshot: TaskSnapshot): void {
    this.tasks.clear();
    this.byRequest.clear();
    this.reviewHashes.clear();
    this.worktrees.clear();
    this.sessions.clear();
    this.permissionResolvers.clear();
    this.turnEpoch.clear();
    for (const task of snapshot.tasks) this.tasks.set(task.taskId, { ...task });
    for (const [requestId, taskId] of snapshot.byRequest) this.byRequest.set(requestId, taskId);
    for (const [taskId, hash] of snapshot.reviewHashes) this.reviewHashes.set(taskId, hash);
    for (const task of this.tasks.values()) this.recoverInFlight(task);
  }

  private recoverInFlight(task: TaskRecord): void {
    if (task.state === "FINALIZING") {
      this.recoverFinalizing(task);
      return;
    }
    if (isTerminalState(task.state)) {
      if (task.worktreePath && task.worktreePath !== task.projectPath) this.cleanupWorktree(task);
      return;
    }
    if (!["QUEUED", "STARTING", "RUNNING", "VERIFYING", "WAITING_FOR_INPUT"].includes(task.state)) {
      return;
    }
    task.interrupted = true;
    task.pendingInput = undefined;
    this.setState(task, "AWAITING_REVIEW");
  }

  private recoverFinalizing(task: TaskRecord): void {
    task.interrupted = true;
    const checkpointCwd =
      task.worktreePath && existsSync(task.worktreePath) ? task.worktreePath : undefined;
    let commit = task.approvedCommit;
    if (!commit && task.reviewTreeOid && checkpointCwd) {
      try {
        commit = checkpointFromTree(
          checkpointCwd,
          task.reviewTreeOid,
          task.baseCommit ?? "",
          task.taskBranch ?? "",
          `checkpoint: ${task.taskId}`,
        );
      } catch (error) {
        this.journal.append("finalizing-recovery-failed", { error: String(error) }, task.taskId);
        this.persist();
        return;
      }
    }
    if (!commit) {
      this.journal.append("finalizing-recovery-failed", { reason: "checkpoint-missing" }, task.taskId);
      this.setState(task, "FAILED");
      return;
    }
    task.approvedCommit = commit;
    task.verdict = "APPROVED";
    this.setState(task, "COMPLETED");
    this.cleanupWorktree(task);
    this.persist();
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
    const isolation = input.isolation?.mode ?? "worktree";
    assertInPlaceAllowed(isolation === "in-place", this.debugWorkers());
    assertExecutableWorker(input.workerId, this.debugWorkers());
    const profile = this.profiles.get(input.workerId);
    if (!profile) throw new Error(`unknown worker ${input.workerId}`);
    const driver = this.drivers.get(profile.preferredRuntime);
    if (!driver) throw new Error(`no driver for ${profile.preferredRuntime}`);

    const baseCommit = repoHead(input.projectPath);
    const targetBranch = currentBranch(input.projectPath);
    const expectedTargetHead = baseCommit;
    const verification = resolveVerification(input, input.projectPath, baseCommit);

    const taskId = randomUUID();
    const worktree =
      isolation === "worktree" ? createTaskWorktree(input.projectPath, taskId, baseCommit) : undefined;
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
      baseCommit,
      targetBranch,
      expectedTargetHead,
      objective: input.objective,
      projectPath: input.projectPath,
      workerId: input.workerId,
      acceptanceCriteria: input.acceptanceCriteria,
      verification: verification.input,
      verificationPlan: verification.plan,
    };
    this.tasks.set(taskId, task);
    this.byRequest.set(input.clientRequestId, taskId);
    this.journal.append("run", input, taskId);

    this.setState(task, "STARTING");
    return this.startTurn(task, input.objective, input);
  }

  private startTurn(task: TaskRecord, text: string, input?: BridgeTaskInput): TaskRecord {
    assertExecutableWorker(task.workerId, this.debugWorkers());
    const profile = this.profiles.get(task.workerId)!;
    const driver = this.drivers.get(profile.preferredRuntime)!;
    if (task.state !== "RUNNING") this.setState(task, "RUNNING");
    const epoch = this.bumpEpoch(task.taskId);
    const pending = this.runTurn(task, profile, driver, text, input, epoch);
    this.turns.set(task.taskId, pending);
    void pending.finally(() => {
      if (this.turns.get(task.taskId) === pending) this.turns.delete(task.taskId);
    });
    return task;
  }

  private bumpEpoch(taskId: string): number {
    const next = (this.turnEpoch.get(taskId) ?? 0) + 1;
    this.turnEpoch.set(taskId, next);
    return next;
  }

  private isCurrentTurn(taskId: string, epoch: number): boolean {
    return this.turnEpoch.get(taskId) === epoch;
  }

  setPermissionMode(mode: PermissionMode): void {
    this.permissionMode = mode;
  }

  invalidateRuntimeSessions(kind: RuntimeDriver["kind"]): void {
    for (const [taskId, session] of this.sessions) {
      if (session.profile.preferredRuntime === kind) this.sessions.delete(taskId);
    }
  }

  private waitReturned(task: TaskRecord): boolean {
    return this.settled(task) || task.state === "WAITING_FOR_INPUT";
  }

  private settled(task: TaskRecord): boolean {
    return ["AWAITING_REVIEW", "COMPLETED", "FAILED", "CANCELLED", "TASK_TIMED_OUT"].includes(
      task.state,
    );
  }

  private shouldAbortTurn(task: TaskRecord, epoch?: number): boolean {
    if (epoch !== undefined && !this.isCurrentTurn(task.taskId, epoch)) return true;
    return task.interrupted || this.settled(task);
  }

  private async runTurn(
    task: TaskRecord,
    profile: WorkerProfile,
    driver: RuntimeDriver,
    text: string,
    input?: BridgeTaskInput,
    epoch = 0,
  ): Promise<void> {
    try {
      let session = this.sessions.get(task.taskId);
      if (!session) {
        const previousSessionId = task.sessionId;
        const started = await driver.start(profile, task.worktreePath ?? task.projectPath, {
          resumeSessionId: previousSessionId,
        });
        if (this.shouldAbortTurn(task, epoch)) {
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
        this.persist();
      }
      if (driver.setPermissionHandler) {
        driver.setPermissionHandler(session.sessionId, async (request) => {
          if (!this.isCurrentTurn(task.taskId, epoch)) return { outcome: "cancelled" as const };
          if (this.permissionMode === "auto") return autoSelectPermission(request.options);
          return await new Promise<PermissionOutcome>((resolve) => {
            this.permissionResolvers.set(task.taskId, resolve);
            task.pendingInput = { kind: "permission", ...request };
            if (task.state === "RUNNING") this.setState(task, "WAITING_FOR_INPUT");
            this.journal.append("permission-request", request, task.taskId);
          });
        });
      }
      try {
        const result = await driver.sendTurn(
          {
            id: session.sessionId,
            profileId: profile.id,
            worktreePath: task.worktreePath ?? task.projectPath,
          },
          { sessionId: session.sessionId, text },
        );
        if (this.shouldAbortTurn(task, epoch)) return;
        task.lastStopReason = result.stopReason;
        this.journal.append("worker-turn-finished", result, task.taskId);
        const verifyIds = task.verification?.enabled ? task.verification.verifyIds : [];
        if (verifyIds.length > 0) {
          this.setState(task, "VERIFYING");
          const verification = runVerification(
            task.worktreePath ?? task.projectPath,
            verifyIds,
            task.verificationPlan,
            Boolean(task.verification?.enabled),
          );
          task.lastVerification = verification;
          this.journal.append("verification-result", verification, task.taskId);
        }
        if (this.shouldAbortTurn(task, epoch)) return;
        this.setState(task, "AWAITING_REVIEW");
      } finally {
        if (this.isCurrentTurn(task.taskId, epoch)) {
          if (session) driver.setPermissionHandler?.(session.sessionId, undefined);
          this.permissionResolvers.delete(task.taskId);
        }
      }
    } catch (error) {
      if (this.shouldAbortTurn(task, epoch)) return;
      task.interrupted = true;
      this.setState(task, "FAILED");
      this.journal.append("failed", { error: String(error) }, task.taskId);
    }
  }

  async wait(taskId: string, timeoutMs = 900_000): Promise<TaskRecord> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const task = this.require(taskId);
      if (this.waitReturned(task)) return task;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return this.expireWait(taskId, timeoutMs);
  }

  private async expireWait(taskId: string, timeoutMs: number): Promise<TaskRecord> {
    const task = this.require(taskId);
    if (this.waitReturned(task)) return task;
    task.interrupted = true;
    task.lastStopReason = "wait_timeout";
    this.bumpEpoch(task.taskId);
    await this.stopSession(task);
    if (["RUNNING", "STARTING", "VERIFYING", "WAITING_FOR_INPUT"].includes(task.state)) {
      this.setState(task, "TASK_TIMED_OUT");
    }
    this.journal.append("wait-timeout", { timeoutMs }, task.taskId);
    return task;
  }

  private async stopSession(task: TaskRecord): Promise<void> {
    const resolver = this.permissionResolvers.get(task.taskId);
    resolver?.({ outcome: "cancelled" });
    this.permissionResolvers.delete(task.taskId);
    task.pendingInput = undefined;
    const session = this.sessions.get(task.taskId);
    if (!session) return;
    const driver = this.drivers.get(session.profile.preferredRuntime);
    const handle = {
      id: session.sessionId,
      profileId: session.profile.id,
      worktreePath: task.worktreePath ?? task.projectPath,
    };
    await driver?.cancel(handle).catch(() => undefined);
    await driver?.close(handle).catch(() => undefined);
    this.sessions.delete(task.taskId);
    task.sessionId = undefined;
    task.workerPid = undefined;
  }

  private captureSnapshot(task: TaskRecord) {
    const cwd = task.worktreePath ?? task.projectPath;
    return buildReviewSnapshot({
      cwd,
      baseCommit: task.baseCommit ?? "",
      verifyIds: task.verification?.enabled ? task.verification.verifyIds : [],
      verificationPlan: task.verificationPlan ?? null,
      verificationResult: task.lastVerification ?? null,
    });
  }

  reviewPacket(taskId: string): ReviewPacket {
    const task = this.require(taskId);
    const snapshot = this.captureSnapshot(task);
    if (snapshot.head !== snapshot.baseCommit) {
      throw new BridgeError(
        ErrorCodes.WORKER_COMMITTED,
        "Worker committed in the worktree; V1 does not support Worker commits",
      );
    }
    const digest = reviewDigest(snapshot);
    task.reviewDigest = digest;
    task.reviewTreeOid = snapshot.resultTreeOid;
    this.reviewHashes.set(taskId, digest);
    this.persist();
    return buildReviewPacket({
      objective: task.objective,
      acceptanceCriteria: task.acceptanceCriteria,
      workerStopReason: task.lastStopReason,
      verification: task.lastVerification,
      changeSet: snapshotToChangeSet(snapshot),
      snapshot,
      digest,
    });
  }

  diff(taskId: string): string {
    const task = this.require(taskId);
    return this.captureSnapshot(task).diff;
  }

  continue(taskId: string, notes: string, expectedStateVersion: number): TaskRecord {
    const task = this.require(taskId);
    return this.mutate(task, expectedStateVersion, () => {
      if (task.state !== "AWAITING_REVIEW" && task.state !== "TASK_TIMED_OUT") {
        throw new Error("continue requires AWAITING_REVIEW or TASK_TIMED_OUT");
      }
      task.verdict = "NEEDS_REVISION";
      task.reviewNotes = notes;
      task.interrupted = false;
      this.setState(task, "RUNNING");
      this.startTurn(task, notes);
      return task;
    });
  }

  respond(taskId: string, optionId: string, expectedStateVersion: number): TaskRecord {
    const task = this.require(taskId);
    return this.mutate(task, expectedStateVersion, () => {
      assertExecutableWorker(task.workerId, this.debugWorkers());
      if (task.state !== "WAITING_FOR_INPUT") throw new Error("respond requires WAITING_FOR_INPUT");
      const resolver = this.permissionResolvers.get(taskId);
      if (!resolver) {
        throw new Error("no live permission waiter; Core restarted — use continue to REHYDRATE");
      }
      if (optionId !== "cancelled") {
        const known = task.pendingInput?.options.some((option) => option.optionId === optionId);
        if (!known) throw new Error(`unknown permission option ${optionId}`);
      }
      task.pendingInput = undefined;
      this.setState(task, "RUNNING");
      resolver(optionId === "cancelled" ? { outcome: "cancelled" } : { outcome: "selected", optionId });
      this.permissionResolvers.delete(taskId);
      return task;
    });
  }

  approve(taskId: string, expectedStateVersion: number): TaskRecord {
    const task = this.require(taskId);
    return this.mutate(task, expectedStateVersion, () => {
      if (task.state !== "AWAITING_REVIEW") throw new Error("approve requires AWAITING_REVIEW");
      const expected = task.reviewDigest ?? this.reviewHashes.get(taskId);
      if (!expected) {
        throw new BridgeError(ErrorCodes.REVIEW_DIGEST_MISSING, "bridge_review_packet must run before approve");
      }
      const snapshot = this.captureSnapshot(task);
      if (snapshot.head !== snapshot.baseCommit) {
        throw new BridgeError(
          ErrorCodes.WORKER_COMMITTED,
          "Worker committed in the worktree; V1 does not support Worker commits",
        );
      }
      const current = reviewDigest(snapshot);
      if (current !== expected) {
        throw new BridgeError(ErrorCodes.REVIEW_DRIFT, "review drift: ReviewDigest changed after review");
      }
      this.setState(task, "FINALIZING");
      task.verdict = "APPROVED";
      task.reviewTreeOid = snapshot.resultTreeOid;
      if (task.worktreePath) {
        task.approvedCommit = checkpointFromTree(
          task.worktreePath,
          snapshot.resultTreeOid,
          task.baseCommit ?? snapshot.baseCommit,
          task.taskBranch ?? "",
          `checkpoint: ${task.taskId}`,
        );
      }
      this.setState(task, "COMPLETED");
      this.cleanupWorktree(task);
      this.persist();
      return task;
    });
  }

  apply(taskId: string, expectedStateVersion: number): TaskRecord {
    const task = this.require(taskId);
    return this.mutate(task, expectedStateVersion, () => {
      if (task.state !== "COMPLETED" || task.verdict !== "APPROVED" || !task.approvedCommit) {
        throw new Error("apply requires an approved checkpoint");
      }
      const head = repoHead(task.projectPath);
      if (task.appliedHead && task.appliedHead === head) return task;
      assertTargetIdle(task.projectPath);
      const branch = currentBranch(task.projectPath);
      if (task.targetBranch && branch !== task.targetBranch) {
        throw new BridgeError(
          ErrorCodes.TARGET_BRANCH_CHANGED,
          `expected branch ${task.targetBranch}, currently ${branch}`,
        );
      }
      if (task.expectedTargetHead && head !== task.expectedTargetHead) {
        throw new BridgeError(
          ErrorCodes.TARGET_HEAD_CHANGED,
          `expected HEAD ${task.expectedTargetHead}, currently ${head}`,
        );
      }
      if (workingTreeDirty(task.projectPath)) {
        throw new BridgeError(ErrorCodes.TARGET_DIRTY, "target working tree is not clean");
      }
      task.stateVersion += 1;
      this.journal.append("apply-claimed", { stateVersion: task.stateVersion }, task.taskId);
      this.persist();
      task.appliedHead = cherryPickToRepo(task.projectPath, task.approvedCommit);
      this.journal.append("applied", { head: task.appliedHead, commit: task.approvedCommit }, task.taskId);
      this.persist();
      return task;
    });
  }

  reject(taskId: string, expectedStateVersion: number): TaskRecord {
    const task = this.require(taskId);
    return this.mutate(task, expectedStateVersion, () => {
      task.verdict = "REJECTED";
      this.setState(task, "FAILED");
      this.cleanupWorktree(task);
      return task;
    });
  }

  async cancel(taskId: string, expectedStateVersion: number): Promise<TaskRecord> {
    const task = this.require(taskId);
    return this.mutateAsync(task, expectedStateVersion, async () => {
      task.interrupted = true;
      await this.stopSession(task);
      if (!["COMPLETED", "FAILED", "CANCELLED"].includes(task.state)) {
        this.setState(task, "CANCELLED");
      }
      this.cleanupWorktree(task);
      return task;
    });
  }

  recoverInterrupted(taskId: string, workerPid?: number): TaskRecord {
    const task = this.require(taskId);
    task.workerPid = workerPid;
    task.interrupted = true;
    this.recoverInFlight(task);
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

  pruneWorktrees(projectPath: string): { removed: string[] } {
    const live = [...this.tasks.values()].filter((task) => !isTerminalState(task.state) && task.worktreePath);
    const protectedKeys = new Set(live.map((task) => worktreeKey(task.worktreePath!)));
    const protectedTaskIds = new Set(live.flatMap((task) => [task.taskId, task.taskId.toLowerCase()]));
    const removed: string[] = [];
    const seen = new Set<string>();
    const candidates = [
      ...listAgentBridgeWorktrees(projectPath),
      ...[...this.tasks.values()]
        .map((task) => task.worktreePath)
        .filter((path): path is string => Boolean(path) && path !== projectPath),
    ];
    for (const path of candidates) {
      const key = worktreeKey(path);
      if (isProtectedAgentBridgeWorktree(path, protectedKeys, protectedTaskIds) || seen.has(key)) continue;
      seen.add(key);
      try {
        removeTaskWorktree({ repoPath: projectPath, worktreePath: path });
        removed.push(path);
      } catch (error) {
        this.journal.append("worktree-cleanup-failed", { error: String(error), path });
      }
    }
    for (const task of this.tasks.values()) {
      if (!task.worktreePath || task.worktreePath === task.projectPath) continue;
      if (isProtectedAgentBridgeWorktree(task.worktreePath, protectedKeys, protectedTaskIds)) continue;
      task.worktreePath = undefined;
    }
    this.journal.append("prune-worktrees", { removed });
    removeEmptyAgentBridgeDir(projectPath);
    return { removed };
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

  private beginMutation(taskId: string): void {
    if (this.mutating.has(taskId)) throw new StateVersionConflictError();
    this.mutating.add(taskId);
  }

  private endMutation(taskId: string): void {
    this.mutating.delete(taskId);
  }

  private mutate<T>(task: TaskRecord, expected: number, fn: () => T): T {
    this.beginMutation(task.taskId);
    try {
      this.assertVersion(task, expected);
      return fn();
    } finally {
      this.endMutation(task.taskId);
    }
  }

  private async mutateAsync<T>(task: TaskRecord, expected: number, fn: () => Promise<T>): Promise<T> {
    this.beginMutation(task.taskId);
    try {
      this.assertVersion(task, expected);
      return await fn();
    } finally {
      this.endMutation(task.taskId);
    }
  }

  private setState(task: TaskRecord, next: TaskRecord["state"]): void {
    task.state = transition(task.state, next);
    task.stateVersion += 1;
    this.journal.append("state-changed", { state: task.state, stateVersion: task.stateVersion }, task.taskId);
    this.persist();
  }
}

function resolveVerification(
  input: BridgeTaskInput,
  projectPath: string,
  baseCommit: string,
): { input: BridgeTaskInput["verification"]; plan: TaskRecord["verificationPlan"] } {
  const plan = loadVerificationPlanFromCommit(projectPath, baseCommit);
  if (input.verification?.enabled) {
    if (!plan) {
      throw new BridgeError(
        ErrorCodes.VERIFICATION_PLAN_MISSING,
        "verification requested but .agent-bridge/verify.json is missing at baseCommit",
      );
    }
    return { input: input.verification, plan };
  }
  const ids = listVerifyIds(plan);
  if (ids.length === 0) return { input: undefined, plan };
  return { input: { enabled: true, verifyIds: ids }, plan };
}

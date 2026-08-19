import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { packageRoot as repoRoot } from "../paths.ts";
import { Journal } from "../persistence/journal.ts";
import { redact } from "../persistence/redact.ts";
import { FileTaskStore, TaskStoreCorruptedError } from "../persistence/store.ts";
import { acquireCoreLock, CoreLockHeldError, type CoreLockHandle } from "../persistence/lock.ts";
import { ReplayRuntimeDriver, type ReplayTurn } from "../runtime/replay/driver.ts";
import { AcpRuntimeDriver } from "../runtime/acp/driver.ts";
import { TaskManager, StateVersionConflictError, TaskAlreadyExistsError } from "../core/task-manager.ts";
import { BridgeError } from "../core/errors.ts";
import { PathEscapeError } from "../workspace/safe-path.ts";
import { debugWorkersAllowed, assertCallableWorker } from "../workers/debug.ts";
import { listAgents, runDoctor, type AgentInfo, type DoctorCheck } from "../core/doctor.ts";
import {
  claudeProfile,
  deepSeekProfile,
  fakeAcpProfile,
  replayProfile,
  resolveClaudeLaunch,
  resolveDeepSeekLaunch,
} from "../workers/profiles.ts";
import type { PermissionMode, RuntimeDriver, WorkerProfile } from "../runtime/contract.ts";
import type { BridgeTaskInput, TaskRecord } from "../core/state.ts";
import type { ReviewPacket } from "../review/packet.ts";

export type BridgeResult = {
  ok: boolean;
  code?: string;
  error?: string;
  usage?: string;
  task?: TaskRecord;
  tasks?: TaskRecord[];
  reviewPacket?: ReviewPacket;
  diff?: string;
  events?: unknown[];
  head?: string;
  version?: string;
  checks?: DoctorCheck[];
  agents?: AgentInfo[];
  removed?: string[];
};

export type BridgeRequest = {
  command: string;
  project?: string;
  objective?: string;
  worker?: string;
  task?: string;
  notes?: string;
  clientRequestId?: string;
  stateVersion?: number;
  inPlace?: boolean;
  verifyIds?: string[];
  files?: Record<string, string>;
  timeoutMs?: number;
  needsAttention?: boolean;
  permissionMode?: PermissionMode;
  optionId?: string;
};

function required(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(
      name === "task"
        ? "missing task (pass the task UUID in field \"task\", not taskId)"
        : `missing ${name}`,
    );
  }
  return value;
}

function dataDirFor(projectPath: string): string {
  const dir = join(projectPath, ".agent-bridge-data");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function fail(error: unknown): BridgeResult {
  const err = error instanceof Error ? error : new Error(String(error));
  const code =
    error instanceof BridgeError
      ? error.code
      : error instanceof PathEscapeError
        ? error.code
        : error instanceof StateVersionConflictError
          ? "STATE_VERSION_CONFLICT"
          : error instanceof TaskAlreadyExistsError
            ? "TASK_ALREADY_EXISTS"
            : error instanceof CoreLockHeldError
              ? "CORE_LOCK_HELD"
              : error instanceof TaskStoreCorruptedError
                ? "TASK_STORE_CORRUPTED"
                : "ERROR";
  return { ok: false, error: err.message, code };
}

type CoreSlot = {
  manager: TaskManager;
  store: FileTaskStore;
  drivers: Map<string, RuntimeDriver>;
  profiles: Map<string, WorkerProfile>;
  lock: CoreLockHandle;
};

const cores = new Map<string, CoreSlot>();

function coreKey(projectPath: string): string {
  return resolve(projectPath).replaceAll("\\", "/").toLowerCase();
}

function ensureWorker(slot: CoreSlot, workerId: string): void {
  if (workerId === "claude" && !slot.profiles.has("claude")) {
    if (!slot.drivers.has("acp")) slot.drivers.set("acp", new AcpRuntimeDriver());
    slot.profiles.set("claude", claudeProfile(resolveClaudeLaunch(repoRoot)));
  }
  if (workerId === "deepseek" && !slot.profiles.has("deepseek")) {
    if (!slot.drivers.has("acp")) slot.drivers.set("acp", new AcpRuntimeDriver());
    slot.profiles.set("deepseek", deepSeekProfile(resolveDeepSeekLaunch(repoRoot)));
  }
  if (workerId === "fake" && !slot.profiles.has("fake")) {
    if (!slot.drivers.has("acp")) slot.drivers.set("acp", new AcpRuntimeDriver());
    slot.profiles.set("fake", fakeAcpProfile(repoRoot));
  }
}

function getCore(
  projectPath: string,
  replayTurn: ReplayTurn | undefined,
  extraWorkers: string[],
): CoreSlot {
  const key = coreKey(projectPath);
  const existing = cores.get(key);
  if (existing) {
    if (debugWorkersAllowed()) {
      existing.drivers.set("replay", new ReplayRuntimeDriver(replayTurn ? [replayTurn] : []));
      existing.manager.invalidateRuntimeSessions("replay");
    }
    for (const workerId of extraWorkers) ensureWorker(existing, workerId);
    return existing;
  }

  const dir = dataDirFor(projectPath);
  const lock = acquireCoreLock(dir);
  try {
    const store = new FileTaskStore(join(dir, "tasks.json"));
    const snapshot = store.load();
    const workerIds = new Set<string>([
      ...(debugWorkersAllowed() ? ["replay"] : []),
      ...extraWorkers,
      ...snapshot.tasks.map((task) => task.workerId),
    ]);
    const drivers = new Map<string, RuntimeDriver>();
    const profiles = new Map<string, WorkerProfile>();
    if (debugWorkersAllowed() && workerIds.has("replay")) {
      drivers.set("replay", new ReplayRuntimeDriver(replayTurn ? [replayTurn] : []));
      profiles.set("replay", replayProfile);
    }
    if ([...workerIds].some((id) => id === "claude" || id === "deepseek" || id === "fake")) {
      drivers.set("acp", new AcpRuntimeDriver());
    }
    if (workerIds.has("claude")) {
      profiles.set("claude", claudeProfile(resolveClaudeLaunch(repoRoot)));
    }
    if (workerIds.has("deepseek")) {
      profiles.set("deepseek", deepSeekProfile(resolveDeepSeekLaunch(repoRoot)));
    }
    if (workerIds.has("fake")) {
      profiles.set("fake", fakeAcpProfile(repoRoot));
    }
    const manager = new TaskManager(drivers, profiles, new Journal(join(dir, "journal.ndjson")));
    manager.setPersist(() => store.save(manager.snapshot()));
    manager.hydrate(snapshot);
    store.save(manager.snapshot());
    const slot = { manager, store, drivers, profiles, lock };
    cores.set(key, slot);
    return slot;
  } catch (error) {
    lock.release();
    throw error;
  }
}

export async function dispatch(request: BridgeRequest): Promise<BridgeResult> {
  if (!request.command || request.command === "help") {
    return {
      ok: true,
      usage:
        "codex-agent-bridge setup|uninstall|run|status|wait|review-packet|diff|approve|continue|respond|reject|cancel|apply|logs|doctor|agents|version|prune",
    };
  }

  try {
    if (request.command === "version") {
      const report = runDoctor({ repoRoot });
      return { ok: true, version: report.version };
    }
    if (request.command === "agents") {
      return { ok: true, agents: listAgents(repoRoot) };
    }
    if (request.command === "doctor") {
      const report = runDoctor({
        repoRoot,
        projectPath: request.project ? resolve(request.project) : undefined,
      });
      return { ok: true, version: report.version, checks: report.checks, agents: report.agents };
    }

    const projectPath = resolve(request.project ?? process.cwd());
    const replayTurn: ReplayTurn = {
      stopReason: "end_turn",
      files: request.files ?? {},
    };
    const extraWorkers = request.worker ? [request.worker] : [];
    const timeoutMs = request.timeoutMs ?? 900_000;
    const { manager, store } = getCore(projectPath, replayTurn, extraWorkers);
    manager.setPermissionMode(request.permissionMode ?? "auto");
    const persist = () => store.save(manager.snapshot());

    const finish = async (taskId: string) => {
      const waited = await manager.wait(taskId, timeoutMs);
      if (waited.state === "AWAITING_REVIEW" || waited.state === "TASK_TIMED_OUT") {
        const reviewPacket = manager.reviewPacket(taskId);
        persist();
        return { ok: true as const, task: waited, reviewPacket };
      }
      persist();
      return { ok: true as const, task: waited };
    };

    if (request.command === "run") {
      const input: BridgeTaskInput = {
        schemaVersion: "1.2",
        clientRequestId: request.clientRequestId ?? `req-${Date.now()}`,
        objective: required(request.objective, "objective"),
        projectPath,
        workerId: assertCallableWorker(request.worker, request.files),
        isolation: { mode: request.inPlace ? "in-place" : "worktree" },
        verification:
          (request.verifyIds ?? []).length > 0
            ? { enabled: true, verifyIds: request.verifyIds ?? [] }
            : undefined,
      };
      const created = manager.run(input);
      return finish(created.taskId);
    }

    if (request.command === "status") {
      if (request.task) return { ok: true, task: manager.get(request.task) };
      return { ok: true, tasks: manager.list({ needsAttention: request.needsAttention }) };
    }
    if (request.command === "wait") {
      return finish(required(request.task, "task"));
    }
    if (request.command === "review-packet") {
      const taskId = required(request.task, "task");
      const reviewPacket = manager.reviewPacket(taskId);
      persist();
      return { ok: true, reviewPacket, task: manager.get(taskId) };
    }
    if (request.command === "diff") {
      return { ok: true, diff: manager.diff(required(request.task, "task")) };
    }
    if (request.command === "approve") {
      const updated = manager.approve(required(request.task, "task"), Number(request.stateVersion));
      persist();
      return { ok: true, task: updated };
    }
    if (request.command === "continue") {
      const updated = manager.continue(
        required(request.task, "task"),
        required(request.notes, "notes"),
        Number(request.stateVersion),
      );
      return finish(updated.taskId);
    }
    if (request.command === "respond") {
      const updated = manager.respond(
        required(request.task, "task"),
        required(request.optionId, "optionId"),
        Number(request.stateVersion),
      );
      persist();
      return finish(updated.taskId);
    }
    if (request.command === "reject") {
      const updated = manager.reject(required(request.task, "task"), Number(request.stateVersion));
      persist();
      return { ok: true, task: updated };
    }
    if (request.command === "cancel") {
      const updated = await manager.cancel(required(request.task, "task"), Number(request.stateVersion));
      persist();
      return { ok: true, task: updated };
    }
    if (request.command === "apply") {
      const updated = manager.apply(required(request.task, "task"), Number(request.stateVersion));
      persist();
      return { ok: true, task: updated, head: updated.appliedHead };
    }
    if (request.command === "prune") {
      const result = manager.pruneWorktrees(projectPath);
      persist();
      return { ok: true, removed: result.removed };
    }
    if (request.command === "logs") {
      const journalPath = join(dataDirFor(projectPath), "journal.ndjson");
      if (!existsSync(journalPath)) {
        return {
          ok: false,
          code: "JOURNAL_MISSING",
          error: `journal missing: ${journalPath}`,
        };
      }
      const raw = readFileSync(journalPath, "utf8");
      const events = raw
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => redact(JSON.parse(line)) as { taskId?: string })
        .filter((event) => !request.task || event.taskId === request.task);
      return { ok: true, events };
    }
    throw new Error(`unknown command ${request.command}`);
  } catch (error) {
    return fail(error);
  }
}

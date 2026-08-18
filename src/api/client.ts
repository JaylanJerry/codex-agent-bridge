import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Journal } from "../persistence/journal.ts";
import { redact } from "../persistence/redact.ts";
import { FileTaskStore } from "../persistence/store.ts";
import { ReplayRuntimeDriver, type ReplayTurn } from "../runtime/replay/driver.ts";
import { AcpRuntimeDriver } from "../runtime/acp/driver.ts";
import { TaskManager, StateVersionConflictError, TaskAlreadyExistsError } from "../core/task-manager.ts";
import { listAgents, runDoctor, type AgentInfo, type DoctorCheck } from "../core/doctor.ts";
import {
  claudeProfile,
  deepSeekProfile,
  replayProfile,
  resolveClaudeLaunch,
  resolveDeepSeekLaunch,
} from "../workers/profiles.ts";
import type { RuntimeDriver, WorkerProfile } from "../runtime/contract.ts";
import type { BridgeTaskInput, TaskRecord } from "../core/state.ts";
import type { ReviewPacket } from "../review/packet.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

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
};

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`missing ${name}`);
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
    error instanceof StateVersionConflictError
      ? "STATE_VERSION_CONFLICT"
      : error instanceof TaskAlreadyExistsError
        ? "TASK_ALREADY_EXISTS"
        : "ERROR";
  return { ok: false, error: err.message, code };
}

function createManager(
  projectPath: string,
  replayTurn: ReplayTurn | undefined,
  extraWorkers: string[],
): { manager: TaskManager; store: FileTaskStore } {
  const dir = dataDirFor(projectPath);
  const store = new FileTaskStore(join(dir, "tasks.json"));
  const snapshot = store.load();
  const workerIds = new Set<string>([
    "replay",
    ...extraWorkers,
    ...snapshot.tasks.map((task) => task.workerId),
  ]);

  const drivers = new Map<string, RuntimeDriver>([
    ["replay", new ReplayRuntimeDriver(replayTurn ? [replayTurn] : [])],
  ]);
  const profiles = new Map<string, WorkerProfile>([["replay", replayProfile]]);

  if ([...workerIds].some((id) => id === "claude" || id === "deepseek")) {
    drivers.set("acp", new AcpRuntimeDriver());
  }
  if (workerIds.has("claude")) {
    profiles.set("claude", claudeProfile(resolveClaudeLaunch(repoRoot)));
  }
  if (workerIds.has("deepseek")) {
    profiles.set("deepseek", deepSeekProfile(resolveDeepSeekLaunch(repoRoot)));
  }

  const manager = new TaskManager(drivers, profiles, new Journal(join(dir, "journal.ndjson")));
  manager.hydrate(snapshot);
  return { manager, store };
}

export async function dispatch(request: BridgeRequest): Promise<BridgeResult> {
  if (!request.command || request.command === "help") {
    return {
      ok: true,
      usage:
        "agent-bridge run|status|wait|review-packet|diff|approve|continue|reject|cancel|apply|logs|doctor|agents|version",
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
    const { manager, store } = createManager(projectPath, replayTurn, extraWorkers);
    const persist = () => store.save(manager.snapshot());

    if (request.command === "run") {
      const input: BridgeTaskInput = {
        schemaVersion: "1.2",
        clientRequestId: request.clientRequestId ?? `req-${Date.now()}`,
        objective: required(request.objective, "objective"),
        projectPath,
        workerId: request.worker ?? "replay",
        isolation: { mode: request.inPlace ? "in-place" : "worktree" },
        verification:
          (request.verifyIds ?? []).length > 0
            ? { enabled: true, verifyIds: request.verifyIds ?? [] }
            : undefined,
      };
      const created = manager.run(input);
      const waited = await manager.wait(created.taskId, timeoutMs);
      const reviewPacket = manager.reviewPacket(waited.taskId);
      persist();
      return { ok: true, task: waited, reviewPacket };
    }

    if (request.command === "status") {
      if (request.task) return { ok: true, task: manager.get(request.task) };
      return { ok: true, tasks: manager.list({ needsAttention: request.needsAttention }) };
    }
    if (request.command === "wait") {
      const waited = await manager.wait(required(request.task, "task"), timeoutMs);
      persist();
      return { ok: true, task: waited };
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
      const waited = await manager.wait(updated.taskId, timeoutMs);
      const reviewPacket = manager.reviewPacket(waited.taskId);
      persist();
      return { ok: true, task: waited, reviewPacket };
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
    if (request.command === "logs") {
      const raw = readFileSync(join(dataDirFor(projectPath), "journal.ndjson"), "utf8");
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

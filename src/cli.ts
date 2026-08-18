#!/usr/bin/env node
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Journal } from "./persistence/journal.ts";
import { FileTaskStore } from "./persistence/store.ts";
import { ReplayRuntimeDriver, type ReplayTurn } from "./runtime/replay/driver.ts";
import { AcpRuntimeDriver } from "./runtime/acp/driver.ts";
import { TaskManager, StateVersionConflictError, TaskAlreadyExistsError } from "./core/task-manager.ts";
import {
  claudeProfile,
  deepSeekProfile,
  replayProfile,
  resolveClaudeLaunch,
  resolveDeepSeekLaunch,
} from "./workers/profiles.ts";
import type { RuntimeDriver, WorkerProfile } from "./runtime/contract.ts";
import type { BridgeTaskInput } from "./core/state.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type FlagMap = {
  command: string;
  values: Record<string, string>;
  lists: Record<string, string[]>;
};

function parseArgv(argv: string[]): FlagMap {
  const [command, ...rest] = argv;
  const values: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = rest[i + 1];
    if (!next || next.startsWith("--")) {
      values[key] = "true";
      continue;
    }
    i += 1;
    if (!lists[key]) lists[key] = [];
    lists[key].push(next);
    values[key] = next;
  }
  return { command: command ?? "help", values, lists };
}

function required(flags: FlagMap, name: string): string {
  const value = flags.values[name];
  if (!value) throw new Error(`missing --${name}`);
  return value;
}

function decodeContents(raw: string): string {
  return raw.replaceAll("\\n", "\n").replaceAll("\\t", "\t");
}

function parseWrites(flags: FlagMap): Record<string, string> {
  const files: Record<string, string> = {};
  for (const item of flags.lists.write ?? []) {
    const idx = item.indexOf("=");
    if (idx <= 0) throw new Error(`--write expects path=contents, got ${item}`);
    files[item.slice(0, idx)] = decodeContents(item.slice(idx + 1));
  }
  return files;
}

function dataDirFor(projectPath: string): string {
  const dir = join(projectPath, ".agent-bridge-data");
  mkdirSync(dir, { recursive: true });
  return dir;
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

function persist(store: FileTaskStore, manager: TaskManager): void {
  store.save(manager.snapshot());
}

function emit(payload: unknown, code = 0): never {
  console.log(JSON.stringify(payload, null, 2));
  process.exit(code);
}

function fail(error: unknown): never {
  const err = error instanceof Error ? error : new Error(String(error));
  const code =
    error instanceof StateVersionConflictError
      ? "STATE_VERSION_CONFLICT"
      : error instanceof TaskAlreadyExistsError
        ? "TASK_ALREADY_EXISTS"
        : "ERROR";
  emit({ ok: false, error: err.message, code }, 1);
}

async function main(): Promise<void> {
  const flags = parseArgv(process.argv.slice(2));
  if (!flags.command || flags.command === "help" || flags.command === "--help") {
    emit({
      ok: true,
      usage: "agent-bridge run|status|wait|review-packet|diff|approve|continue|reject|cancel|logs",
    });
  }

  try {
    const projectPath = resolve(flags.values.project ?? process.cwd());
    const replayTurn: ReplayTurn = {
      stopReason: "end_turn",
      files: parseWrites(flags),
    };
    const extraWorkers = flags.values.worker ? [flags.values.worker] : [];
    const { manager, store } = createManager(projectPath, replayTurn, extraWorkers);

    if (flags.command === "run") {
      const input: BridgeTaskInput = {
        schemaVersion: "1.2",
        clientRequestId: flags.values["client-request-id"] ?? `req-${Date.now()}`,
        objective: required(flags, "objective"),
        projectPath,
        workerId: flags.values.worker ?? "replay",
        isolation: { mode: flags.values["in-place"] === "true" ? "in-place" : "worktree" },
        verification:
          (flags.lists.verify ?? []).length > 0
            ? { enabled: true, verifyIds: flags.lists.verify }
            : undefined,
      };
      const created = manager.run(input);
      const waited = await manager.wait(created.taskId);
      persist(store, manager);
      emit({ ok: true, task: waited, reviewPacket: manager.reviewPacket(waited.taskId) });
    }

    if (flags.command === "status") {
      if (flags.values.task) emit({ ok: true, task: manager.get(flags.values.task) });
      emit({ ok: true, tasks: manager.list() });
    }
    if (flags.command === "wait") {
      const waited = await manager.wait(required(flags, "task"));
      persist(store, manager);
      emit({ ok: true, task: waited });
    }
    if (flags.command === "review-packet") {
      const taskId = required(flags, "task");
      emit({ ok: true, reviewPacket: manager.reviewPacket(taskId), task: manager.get(taskId) });
    }
    if (flags.command === "diff") {
      emit({ ok: true, diff: manager.diff(required(flags, "task")) });
    }
    if (flags.command === "approve") {
      const updated = manager.approve(required(flags, "task"), Number(required(flags, "state-version")));
      persist(store, manager);
      emit({ ok: true, task: updated });
    }
    if (flags.command === "continue") {
      const updated = manager.continue(
        required(flags, "task"),
        required(flags, "notes"),
        Number(required(flags, "state-version")),
      );
      const waited = await manager.wait(updated.taskId);
      persist(store, manager);
      emit({ ok: true, task: waited, reviewPacket: manager.reviewPacket(waited.taskId) });
    }
    if (flags.command === "reject") {
      const updated = manager.reject(required(flags, "task"), Number(required(flags, "state-version")));
      persist(store, manager);
      emit({ ok: true, task: updated });
    }
    if (flags.command === "cancel") {
      const updated = await manager.cancel(required(flags, "task"), Number(required(flags, "state-version")));
      persist(store, manager);
      emit({ ok: true, task: updated });
    }
    if (flags.command === "logs") {
      const raw = readFileSync(join(dataDirFor(projectPath), "journal.ndjson"), "utf8");
      const taskId = flags.values.task;
      const events = raw
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { taskId?: string })
        .filter((event) => !taskId || event.taskId === taskId);
      emit({ ok: true, events });
    }
    throw new Error(`unknown command ${flags.command}`);
  } catch (error) {
    fail(error);
  }
}

await main();

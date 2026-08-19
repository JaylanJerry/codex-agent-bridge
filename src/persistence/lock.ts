/** One Writer Core per data directory. Not a single-task limit. */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

export class CoreLockHeldError extends Error {
  readonly code = "CORE_LOCK_HELD";

  constructor(message = "CORE_LOCK_HELD") {
    super(message);
    this.name = "CoreLockHeldError";
  }
}

export type CoreLockHandle = {
  path: string;
  pid: number;
  release: () => void;
};

export type CoreLockInspection = {
  state: "absent" | "held" | "stale" | "unreadable";
  pid?: number;
  detail: string;
};

type LockPayload = {
  pid: number;
  startedAt: string;
  hostname?: string;
};

const held = new Map<string, CoreLockHandle>();

function lockPathFor(dataDir: string): string {
  return join(dataDir, "core.lock");
}

function isPidAlive(pid: number): boolean | "unknown" {
  if (!Number.isInteger(pid) || pid <= 0) return "unknown";
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    return "unknown";
  }
}

function readPayload(lockPath: string): LockPayload | undefined {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as LockPayload;
    if (!parsed || typeof parsed !== "object" || !Number.isInteger(parsed.pid)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function writeExclusive(lockPath: string): boolean {
  const payload: LockPayload = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    hostname: hostname(),
  };
  try {
    writeFileSync(lockPath, `${JSON.stringify(payload)}\n`, { flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

function unlinkQuiet(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // raced or already gone
  }
}

function makeHandle(lockPath: string): CoreLockHandle {
  let released = false;
  const handle: CoreLockHandle = {
    path: lockPath,
    pid: process.pid,
    release: () => {
      if (released) return;
      released = true;
      held.delete(lockPath);
      const current = readPayload(lockPath);
      if (current?.pid === process.pid) unlinkQuiet(lockPath);
    },
  };
  held.set(lockPath, handle);
  return handle;
}

export function inspectCoreLock(dataDir: string): CoreLockInspection {
  const lockPath = lockPathFor(dataDir);
  if (!existsSync(lockPath)) {
    return { state: "absent", detail: "no core.lock" };
  }
  const payload = readPayload(lockPath);
  if (!payload) {
    return { state: "unreadable", detail: "core.lock unreadable; fail-closed (do not delete blindly)" };
  }
  const alive = isPidAlive(payload.pid);
  if (alive === true) {
    return { state: "held", pid: payload.pid, detail: `writer pid ${payload.pid} is alive` };
  }
  if (alive === false) {
    return { state: "stale", pid: payload.pid, detail: `stale lock; pid ${payload.pid} is dead` };
  }
  return {
    state: "unreadable",
    pid: payload.pid,
    detail: `cannot determine whether pid ${payload.pid} is alive; fail-closed`,
  };
}

export function acquireCoreLock(dataDir: string): CoreLockHandle {
  mkdirSync(dataDir, { recursive: true });
  const lockPath = lockPathFor(dataDir);
  const existing = held.get(lockPath);
  if (existing) return existing;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (writeExclusive(lockPath)) return makeHandle(lockPath);

    const inspection = inspectCoreLock(dataDir);
    if (inspection.state === "held") {
      if (inspection.pid === process.pid) {
        return held.get(lockPath) ?? makeHandle(lockPath);
      }
      throw new CoreLockHeldError(`CORE_LOCK_HELD: writer pid ${inspection.pid}`);
    }
    if (inspection.state === "unreadable") {
      throw new CoreLockHeldError(`CORE_LOCK_HELD: ${inspection.detail}`);
    }
    if (inspection.state === "stale") {
      unlinkQuiet(lockPath);
      continue;
    }
    unlinkQuiet(lockPath);
  }
  throw new CoreLockHeldError("CORE_LOCK_HELD: could not acquire core.lock");
}

function releaseHeldLocks(): void {
  for (const handle of [...held.values()]) handle.release();
}

process.on("exit", releaseHeldLocks);

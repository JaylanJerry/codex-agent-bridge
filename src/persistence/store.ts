import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import type { TaskRecord } from "../core/state.ts";
import { STORE_VERSION } from "./layout.ts";

export class TaskStoreCorruptedError extends Error {
  readonly code = "TASK_STORE_CORRUPTED";

  constructor(path: string, cause?: unknown) {
    const detail = cause instanceof Error ? cause.message : cause ? String(cause) : "invalid JSON";
    super(`TASK_STORE_CORRUPTED: ${path}: ${detail}`);
    this.name = "TaskStoreCorruptedError";
  }
}

export type TaskSnapshot = {
  storeVersion?: number;
  tasks: TaskRecord[];
  byRequest: [string, string][];
  reviewHashes: [string, string][];
};

function emptySnapshot(): TaskSnapshot {
  return { storeVersion: STORE_VERSION, tasks: [], byRequest: [], reviewHashes: [] };
}

function atomicWriteFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch {
    copyFileSync(tmp, path);
    unlinkSync(tmp);
  }
}

export class FileTaskStore {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  load(): TaskSnapshot {
    if (!existsSync(this.path)) return emptySnapshot();
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (error) {
      throw new TaskStoreCorruptedError(this.path, error);
    }
    try {
      const parsed = JSON.parse(raw) as TaskSnapshot;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("root must be an object");
      }
      const storeVersion =
        typeof parsed.storeVersion === "number" ? parsed.storeVersion : 1;
      if (!Number.isInteger(storeVersion) || storeVersion < 1) {
        throw new Error("storeVersion must be a positive integer");
      }
      if (storeVersion > STORE_VERSION) {
        throw new Error(`unsupported storeVersion ${storeVersion}`);
      }
      return {
        storeVersion,
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
        byRequest: Array.isArray(parsed.byRequest) ? parsed.byRequest : [],
        reviewHashes: Array.isArray(parsed.reviewHashes) ? parsed.reviewHashes : [],
      };
    } catch (error) {
      throw new TaskStoreCorruptedError(this.path, error);
    }
  }

  save(snapshot: TaskSnapshot): void {
    atomicWriteFile(
      this.path,
      `${JSON.stringify({ ...snapshot, storeVersion: STORE_VERSION }, null, 2)}\n`,
    );
  }
}

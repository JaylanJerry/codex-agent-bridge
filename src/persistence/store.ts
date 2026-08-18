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

export class TaskStoreCorruptedError extends Error {
  readonly code = "TASK_STORE_CORRUPTED";

  constructor(path: string, cause?: unknown) {
    const detail = cause instanceof Error ? cause.message : cause ? String(cause) : "invalid JSON";
    super(`TASK_STORE_CORRUPTED: ${path}: ${detail}`);
    this.name = "TaskStoreCorruptedError";
  }
}

export type TaskSnapshot = {
  tasks: TaskRecord[];
  byRequest: [string, string][];
  reviewHashes: [string, string][];
};

function emptySnapshot(): TaskSnapshot {
  return { tasks: [], byRequest: [], reviewHashes: [] };
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
      return {
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
        byRequest: Array.isArray(parsed.byRequest) ? parsed.byRequest : [],
        reviewHashes: Array.isArray(parsed.reviewHashes) ? parsed.reviewHashes : [],
      };
    } catch (error) {
      throw new TaskStoreCorruptedError(this.path, error);
    }
  }

  save(snapshot: TaskSnapshot): void {
    atomicWriteFile(this.path, `${JSON.stringify(snapshot, null, 2)}\n`);
  }
}

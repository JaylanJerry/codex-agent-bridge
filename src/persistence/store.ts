import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { TaskRecord } from "../core/state.ts";

export type TaskSnapshot = {
  tasks: TaskRecord[];
  byRequest: [string, string][];
  reviewHashes: [string, string][];
};

export class FileTaskStore {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  load(): TaskSnapshot {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as TaskSnapshot;
      return {
        tasks: parsed.tasks ?? [],
        byRequest: parsed.byRequest ?? [],
        reviewHashes: parsed.reviewHashes ?? [],
      };
    } catch {
      return { tasks: [], byRequest: [], reviewHashes: [] };
    }
  }

  save(snapshot: TaskSnapshot): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(snapshot, null, 2)}\n`);
  }
}

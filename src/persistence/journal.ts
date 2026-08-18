import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { redact } from "./redact.ts";

export type JournalEvent = {
  seq: number;
  timestamp: string;
  taskId?: string;
  type: string;
  payload?: unknown;
};

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_KEEP = 5;

export class Journal {
  private seq = 0;
  private readonly maxBytes: number;
  private readonly keep: number;

  constructor(
    private readonly path: string,
    options?: { maxBytes?: number; keep?: number },
  ) {
    mkdirSync(dirname(this.path), { recursive: true });
    this.maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
    this.keep = options?.keep ?? DEFAULT_KEEP;
  }

  append(type: string, payload?: unknown, taskId?: string): JournalEvent {
    this.rotateIfNeeded();
    const event: JournalEvent = {
      seq: ++this.seq,
      timestamp: new Date().toISOString(),
      taskId,
      type,
      payload: payload === undefined ? undefined : redact(payload),
    };
    appendFileSync(this.path, `${JSON.stringify(event)}\n`);
    return event;
  }

  private rotateIfNeeded(): void {
    if (!existsSync(this.path)) return;
    if (statSync(this.path).size < this.maxBytes) return;
    const last = `${this.path}.${this.keep}`;
    if (existsSync(last)) unlinkSync(last);
    for (let index = this.keep - 1; index >= 1; index -= 1) {
      const from = `${this.path}.${index}`;
      const to = `${this.path}.${index + 1}`;
      if (!existsSync(from)) continue;
      if (existsSync(to)) unlinkSync(to);
      renameSync(from, to);
    }
    const first = `${this.path}.1`;
    if (existsSync(first)) unlinkSync(first);
    renameSync(this.path, first);
    this.seq = 0;
  }
}

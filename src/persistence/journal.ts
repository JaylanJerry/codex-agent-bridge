import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { redact } from "./redact.ts";

export type JournalEvent = {
  seq: number;
  timestamp: string;
  taskId?: string;
  type: string;
  payload?: unknown;
};

export class Journal {
  private seq = 0;

  constructor(private readonly path: string) {
    mkdirSync(dirname(this.path), { recursive: true });
  }

  append(type: string, payload?: unknown, taskId?: string): JournalEvent {
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
}

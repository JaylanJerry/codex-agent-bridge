import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RuntimeDriver, RuntimeSession, TurnInput, WorkerProfile } from "../contract.ts";

export type ReplayTurn = {
  stopReason: "end_turn" | "cancelled";
  files?: Record<string, string>;
};

export class ReplayRuntimeDriver implements RuntimeDriver {
  readonly kind = "replay" as const;
  private readonly queues = new Map<string, ReplayTurn[]>();

  constructor(private readonly script: ReplayTurn[]) {}

  async start(profile: WorkerProfile, worktreePath: string): Promise<RuntimeSession> {
    const session: RuntimeSession = {
      id: `replay-${profile.id}-${Date.now()}`,
      profileId: profile.id,
      worktreePath,
    };
    this.queues.set(session.id, [...this.script]);
    return session;
  }

  async sendTurn(session: RuntimeSession, _input: TurnInput): Promise<{ stopReason: string }> {
    const queue = this.queues.get(session.id) ?? [];
    const turn = queue.shift();
    this.queues.set(session.id, queue);
    if (!turn) throw new Error("replay script exhausted");
    for (const [relative, contents] of Object.entries(turn.files ?? {})) {
      const target = join(session.worktreePath, relative);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, contents);
    }
    return { stopReason: turn.stopReason };
  }

  async cancel(session: RuntimeSession): Promise<void> {
    this.queues.set(session.id, []);
  }

  async close(session: RuntimeSession): Promise<void> {
    this.queues.delete(session.id);
  }
}

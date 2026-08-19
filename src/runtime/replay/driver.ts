import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RuntimeDriver, RuntimeSession, StartOptions, TurnInput, WorkerProfile } from "../contract.ts";
import { safeJoinWorktree } from "../../workspace/safe-path.ts";

export type ReplayTurn = {
  stopReason: "end_turn" | "cancelled";
  files?: Record<string, string>;
};

export class ReplayRuntimeDriver implements RuntimeDriver {
  readonly kind = "replay" as const;
  private readonly queues = new Map<string, ReplayTurn[]>();

  constructor(private readonly script: ReplayTurn[]) {}

  async start(
    profile: WorkerProfile,
    worktreePath: string,
    options?: StartOptions,
  ): Promise<RuntimeSession> {
    const session: RuntimeSession = {
      id: options?.resumeSessionId ?? `replay-${profile.id}-${Date.now()}`,
      profileId: profile.id,
      worktreePath,
      resumed: Boolean(options?.resumeSessionId),
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
      const target = safeJoinWorktree(session.worktreePath, relative);
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

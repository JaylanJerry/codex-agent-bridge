export type RuntimeKind = "acp" | "replay";

export type RuntimeOwnership = "bridge-owned" | "external-owned" | "shared-service";

export type WorkerProfile = {
  id: string;
  displayName: string;
  preferredRuntime: RuntimeKind;
  ownership: RuntimeOwnership;
  launch: {
    command: string;
    args: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  };
};

export type TurnInput = {
  sessionId: string;
  text: string;
};

export type RuntimeEvent =
  | { type: "runtime-started"; pid?: number }
  | { type: "session-created"; sessionId: string }
  | { type: "agent-message"; text: string }
  | { type: "permission-request"; request: unknown }
  | { type: "worker-turn-finished"; stopReason: string }
  | { type: "process-exit"; code: number | null; signal: NodeJS.Signals | null };

export type RuntimeSession = {
  id: string;
  profileId: string;
  worktreePath: string;
  pid?: number;
  loadSession?: boolean;
};

export interface RuntimeDriver {
  readonly kind: RuntimeKind;
  start(profile: WorkerProfile, worktreePath: string): Promise<RuntimeSession>;
  sendTurn(session: RuntimeSession, input: TurnInput): Promise<{ stopReason: string }>;
  cancel(session: RuntimeSession): Promise<void>;
  close(session: RuntimeSession): Promise<void>;
}

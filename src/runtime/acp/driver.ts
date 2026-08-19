import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type {
  PermissionHandler,
  PermissionOutcome,
  RuntimeDriver,
  RuntimeSession,
  StartOptions,
  TurnInput,
  WorkerProfile,
} from "../contract.ts";
import { autoSelectPermission } from "../contract.ts";
import type { JobHandle } from "../../process/job-object.ts";

export const DEFAULT_ACP_STARTUP_TIMEOUT_MS = 30_000;
export const ACP_STDERR_LIMIT = 16 * 1024;

type LiveSession = {
  session: RuntimeSession;
  child: ChildProcessWithoutNullStreams;
  connection: acp.ClientSideConnection;
  job?: JobHandle;
  stderr: string;
  permissionHandler?: PermissionHandler;
};

function extractText(prompt: TurnInput["text"] | unknown): string {
  return typeof prompt === "string" ? prompt : String(prompt);
}

export function capText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(text.length - limit);
}

export function startupTimeoutMs(options?: StartOptions): number {
  if (typeof options?.startupTimeoutMs === "number" && Number.isFinite(options.startupTimeoutMs) && options.startupTimeoutMs > 0) {
    return options.startupTimeoutMs;
  }
  const env = Number(process.env.AGENT_BRIDGE_ACP_STARTUP_TIMEOUT_MS);
  if (Number.isFinite(env) && env > 0) return env;
  return DEFAULT_ACP_STARTUP_TIMEOUT_MS;
}

function appendStderr(live: LiveSession, chunk: string): void {
  live.stderr = capText(live.stderr + chunk, ACP_STDERR_LIMIT);
}

function createStartupSignal(options: StartOptions | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const budget = new AbortController();
  const timer = setTimeout(() => {
    budget.abort(new Error(`ACP startup timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  const onUserAbort = () => {
    if (!budget.signal.aborted) budget.abort(options?.signal?.reason);
  };
  options?.signal?.addEventListener("abort", onUserAbort, { once: true });
  const signal = options?.signal ? AbortSignal.any([options.signal, budget.signal]) : budget.signal;
  return {
    signal,
    dispose() {
      clearTimeout(timer);
      options?.signal?.removeEventListener("abort", onUserAbort);
    },
  };
}

function startupFailureMessage(options: StartOptions | undefined, timeoutMs: number, stderr: string): string {
  const prefix = options?.signal?.aborted
    ? "ACP startup aborted"
    : `ACP startup timed out after ${timeoutMs}ms`;
  return `${prefix}; stderr=${stderr}`;
}

async function withStartupBudget<T>(work: Promise<T>, signal: AbortSignal, onAbort: () => Promise<void>): Promise<T> {
  if (signal.aborted) {
    await onAbort();
    throw signal.reason instanceof Error ? signal.reason : new Error("ACP startup aborted");
  }
  let abortListener: (() => void) | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      abortListener = () => {
        void onAbort();
        reject(signal.reason instanceof Error ? signal.reason : new Error("ACP startup aborted"));
      };
      signal.addEventListener("abort", abortListener, { once: true });
      work.then(resolve, reject);
    });
  } finally {
    if (abortListener) signal.removeEventListener("abort", abortListener);
  }
}

export class AcpRuntimeDriver implements RuntimeDriver {
  readonly kind = "acp" as const;
  private readonly live = new Map<string, LiveSession>();

  async start(
    profile: WorkerProfile,
    worktreePath: string,
    options?: StartOptions,
  ): Promise<RuntimeSession> {
    const child = spawn(profile.launch.command, profile.launch.args, {
      cwd: profile.launch.cwd ?? worktreePath,
      env: { ...process.env, ...profile.launch.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: false,
      shell: false,
    }) as ChildProcessWithoutNullStreams;
    if (!child.stdin || !child.stdout) {
      child.kill();
      throw new Error(`ACP worker ${profile.id} missing stdio`);
    }

    let job: JobHandle | undefined;
    if (profile.ownership === "bridge-owned" && process.platform === "win32" && child.pid) {
      try {
        const jobObject = await import("../../process/job-object.ts");
        job = jobObject.createKillOnCloseJob();
        jobObject.assignPidToJob(job, child.pid);
      } catch (error) {
        child.kill();
        job?.close();
        throw error;
      }
    }

    const live: LiveSession = {
      session: {
        id: "",
        profileId: profile.id,
        worktreePath,
        pid: child.pid,
      },
      child,
      connection: undefined as unknown as acp.ClientSideConnection,
      job,
      stderr: "",
    };
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      appendStderr(live, chunk);
    });
    child.on("error", (error) => {
      appendStderr(live, `\nspawn error: ${error.message}`);
    });
    child.on("exit", (code, signal) => {
      appendStderr(live, `\nexit code=${code} signal=${signal}`);
    });

    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin),
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    live.connection = new acp.ClientSideConnection(() => {
      return {
        requestPermission: async (params: acp.RequestPermissionRequest) => {
          const options = params.options.map((option) => ({
            optionId: option.optionId,
            kind: option.kind,
            name: option.name,
          }));
          const decided: PermissionOutcome = live.permissionHandler
            ? await live.permissionHandler({
                sessionId: params.sessionId,
                title: params.toolCall.title ?? undefined,
                options,
              })
            : autoSelectPermission(options);
          if (decided.outcome === "cancelled") return { outcome: { outcome: "cancelled" } };
          return { outcome: { outcome: "selected", optionId: decided.optionId } };
        },
        async sessionUpdate() {},
      };
    }, stream);

    const timeoutMs = startupTimeoutMs(options);
    const budget = createStartupSignal(options, timeoutMs);
    const handshake = async (): Promise<RuntimeSession> => {
      const init = await live.connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "agent-bridge", version: "1.0.0" },
      });
      live.session.loadSession = Boolean(init.agentCapabilities?.loadSession);
      const resumeId = options?.resumeSessionId;
      if (resumeId && live.session.loadSession) {
        try {
          await live.connection.loadSession({
            sessionId: resumeId,
            cwd: worktreePath,
            mcpServers: [],
          });
          live.session.id = resumeId;
          live.session.resumed = true;
          return live.session;
        } catch {
          // Agent advertised loadSession but this id could not be restored.
        }
      }
      const created = await live.connection.newSession({
        cwd: worktreePath,
        mcpServers: [],
      });
      live.session.id = created.sessionId;
      live.session.resumed = false;
      return live.session;
    };

    try {
      const session = await withStartupBudget(handshake(), budget.signal, () => this.teardown(live));
      if (budget.signal.aborted) {
        this.live.delete(session.id);
        await this.teardown(live);
        throw new Error(startupFailureMessage(options, timeoutMs, live.stderr));
      }
      this.live.set(session.id, live);
      return session;
    } catch (error) {
      if (live.session.id) this.live.delete(live.session.id);
      await this.teardown(live);
      if (budget.signal.aborted) {
        throw new Error(startupFailureMessage(options, timeoutMs, live.stderr));
      }
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; stderr=${live.stderr}`,
      );
    } finally {
      budget.dispose();
    }
  }

  setPermissionHandler(sessionId: string, handler: PermissionHandler | undefined): void {
    const live = this.live.get(sessionId);
    if (live) live.permissionHandler = handler;
  }

  async sendTurn(session: RuntimeSession, input: TurnInput): Promise<{ stopReason: string }> {
    const live = this.require(session.id);
    const result = await live.connection.prompt({
      sessionId: session.id,
      prompt: [{ type: "text", text: extractText(input.text) }],
    });
    return { stopReason: result.stopReason };
  }

  async cancel(session: RuntimeSession): Promise<void> {
    const live = this.live.get(session.id);
    if (!live) return;
    await live.connection.cancel({ sessionId: session.id });
  }

  async close(session: RuntimeSession): Promise<void> {
    const live = this.live.get(session.id);
    if (!live) return;
    this.live.delete(session.id);
    await this.teardown(live);
  }

  private require(sessionId: string): LiveSession {
    const live = this.live.get(sessionId);
    if (!live) throw new Error(`unknown ACP session ${sessionId}`);
    return live;
  }

  private async teardown(live: LiveSession): Promise<void> {
    try {
      live.child.kill();
    } catch {
      // already dead
    }
    live.job?.close();
    await new Promise<void>((resolve) => {
      if (live.child.exitCode !== null || live.child.signalCode) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        try {
          live.child.kill("SIGKILL");
        } catch {
          // already dead
        }
        resolve();
      }, 1000);
      live.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    live.child.stdin?.destroy();
    live.child.stdout?.destroy();
    live.child.stderr?.destroy();
    live.child.unref();
  }
}

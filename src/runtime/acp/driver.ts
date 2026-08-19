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
    child.on("error", (error) => {
      live.stderr += `\nspawn error: ${error.message}`;
    });
    child.on("exit", (code, signal) => {
      live.stderr += `\nexit code=${code} signal=${signal}`;
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

    try {
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
          this.live.set(resumeId, live);
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
      this.live.set(created.sessionId, live);
      return live.session;
    } catch (error) {
      await this.teardown(live);
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; stderr=${live.stderr}`,
      );
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

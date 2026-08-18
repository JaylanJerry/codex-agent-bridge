import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { RuntimeDriver, RuntimeSession, TurnInput, WorkerProfile } from "../contract.ts";
import type { JobHandle } from "../../process/job-object.ts";

type LiveSession = {
  session: RuntimeSession;
  child: ChildProcessWithoutNullStreams;
  connection: acp.ClientSideConnection;
  job?: JobHandle;
  stderr: string;
};

function extractText(prompt: TurnInput["text"] | unknown): string {
  return typeof prompt === "string" ? prompt : String(prompt);
}

export class AcpRuntimeDriver implements RuntimeDriver {
  readonly kind = "acp" as const;
  private readonly live = new Map<string, LiveSession>();

  async start(profile: WorkerProfile, worktreePath: string): Promise<RuntimeSession> {
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
        async requestPermission(params) {
          const selected =
            params.options.find((option) => option.kind === "allow_once") ??
            params.options.find((option) => option.optionId.includes("allow")) ??
            params.options[0];
          if (!selected) return { outcome: { outcome: "cancelled" } };
          return { outcome: { outcome: "selected", optionId: selected.optionId } };
        },
        async sessionUpdate() {},
      };
    }, stream);

    try {
      const init = await live.connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "agent-bridge", version: "0.5.0" },
      });
      const created = await live.connection.newSession({
        cwd: worktreePath,
        mcpServers: [],
      });
      live.session.id = created.sessionId;
      live.session.loadSession = Boolean(init.agentCapabilities?.loadSession);
      this.live.set(created.sessionId, live);
      return live.session;
    } catch (error) {
      await this.teardown(live);
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; stderr=${live.stderr}`,
      );
    }
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
      const timer = setTimeout(resolve, 1000);
      live.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

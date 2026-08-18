import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { ProtocolRecorder } from "./recorder.ts";

export const experimentRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const repoRoot = resolve(experimentRoot, "../..");
export const fixtureRoot = resolve(experimentRoot, "fixtures/math-repo");
export const artifactDir = resolve(repoRoot, "phase0/artifacts");

export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export function spawnAgent(
  command: string,
  args: string[],
  cwd: string,
  extraEnv: NodeJS.ProcessEnv = {},
): ChildProcessWithoutNullStreams {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: false,
    shell: false,
  });
  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error(`${command} missing stdio pipes`);
  }
  return child as ChildProcessWithoutNullStreams;
}

export type AcpRunResult = {
  startedAt: string;
  finishedAt?: string;
  ok: boolean;
  error?: string;
  initialize?: unknown;
  sessionId?: string;
  prompt?: unknown;
  secondPrompt?: unknown;
  cancelPrompt?: unknown;
  permissionRequests: unknown[];
  sessionUpdates: number;
  processExit?: { code: number | null; signal: NodeJS.Signals | null };
};

export async function runAcpSession(opts: {
  name: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  promptText?: string;
  secondPromptText?: string;
  cancelAfterMs?: number;
  timeoutMs?: number;
}): Promise<AcpRunResult> {
  mkdirSync(artifactDir, { recursive: true });
  const recorder = new ProtocolRecorder(resolve(artifactDir, `${opts.name}.ndjson`));
  const stderr = createWriteStream(resolve(artifactDir, `${opts.name}.stderr.log`));
  const summaryPath = resolve(artifactDir, `${opts.name}-summary.json`);
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const result: AcpRunResult = {
    startedAt: new Date().toISOString(),
    ok: false,
    permissionRequests: [],
    sessionUpdates: 0,
  };

  const child = spawnAgent(opts.command, opts.args, opts.cwd ?? fixtureRoot, opts.env);
  child.stderr.on("data", (chunk: Buffer) => {
    stderr.write(chunk);
    process.stderr.write(chunk);
  });
  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit) => child.on("exit", (code, signal) => resolveExit({ code, signal })),
  );

  recorder.tapWritable(child.stdin);
  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin),
    Readable.toWeb(recorder.tapReadable(child.stdout)) as ReadableStream<Uint8Array>,
  );

  const connection = new acp.ClientSideConnection(() => {
    return {
      async requestPermission(params) {
        result.permissionRequests.push({
          timestamp: new Date().toISOString(),
          toolCall: params.toolCall,
          options: params.options,
        });
        const selected =
          params.options.find((option) => option.kind === "allow_once") ??
          params.options.find((option) => option.optionId.includes("allow")) ??
          params.options[0];
        if (!selected) return { outcome: { outcome: "cancelled" } };
        return { outcome: { outcome: "selected", optionId: selected.optionId } };
      },
      async sessionUpdate() {
        result.sessionUpdates += 1;
      },
    };
  }, stream);

  try {
    result.initialize = await withTimeout(
      connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: `agent-relay-phase0-${opts.name}`, version: "0.1.0" },
      }),
      timeoutMs,
      "initialize",
    );
    const session = await withTimeout(
      connection.newSession({ cwd: fixtureRoot, mcpServers: [] }),
      timeoutMs,
      "session/new",
    );
    result.sessionId = session.sessionId;

    if (opts.promptText) {
      const promptPromise = connection.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: opts.promptText }],
      });
      if (opts.cancelAfterMs !== undefined) {
        await sleep(opts.cancelAfterMs);
        await connection.cancel({ sessionId: session.sessionId });
        result.cancelPrompt = await withTimeout(promptPromise, timeoutMs, "cancelled prompt");
        result.ok =
          typeof result.cancelPrompt === "object" &&
          result.cancelPrompt !== null &&
          "stopReason" in result.cancelPrompt &&
          (result.cancelPrompt as { stopReason?: string }).stopReason === "cancelled";
        if (!result.ok) {
          result.error = `expected cancelled, got ${JSON.stringify(result.cancelPrompt)}`;
        }
      } else {
        result.prompt = await withTimeout(promptPromise, timeoutMs, "prompt");
        const firstOk =
          typeof result.prompt === "object" &&
          result.prompt !== null &&
          "stopReason" in result.prompt;
        if (opts.secondPromptText) {
          result.secondPrompt = await withTimeout(
            connection.prompt({
              sessionId: session.sessionId,
              prompt: [{ type: "text", text: opts.secondPromptText }],
            }),
            timeoutMs,
            "second prompt",
          );
          result.ok =
            firstOk &&
            typeof result.secondPrompt === "object" &&
            result.secondPrompt !== null &&
            "stopReason" in result.secondPrompt;
        } else {
          result.ok = firstOk;
        }
      }
    } else {
      result.ok = true;
    }
  } catch (error) {
    result.error = error instanceof Error ? error.stack ?? error.message : String(error);
  } finally {
    child.kill("SIGTERM");
    result.processExit = await Promise.race([
      exitPromise,
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
        setTimeout(() => {
          child.kill("SIGKILL");
          resolveExit({ code: null, signal: "SIGKILL" });
        }, 5000);
      }),
    ]);
    result.finishedAt = new Date().toISOString();
    await recorder.close();
    stderr.end();
    writeFileSync(summaryPath, `${JSON.stringify(result, null, 2)}\n`);
  }

  return result;
}

export function printAndExit(result: AcpRunResult): void {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

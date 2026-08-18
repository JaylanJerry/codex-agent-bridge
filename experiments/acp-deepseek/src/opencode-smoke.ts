import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { ProtocolRecorder } from "./recorder.ts";

const here = dirname(fileURLToPath(import.meta.url));
const experimentRoot = resolve(here, "..");
const repoRoot = resolve(experimentRoot, "../..");
const fixtureRoot = resolve(experimentRoot, "fixtures/math-repo");
const artifactDir = resolve(repoRoot, "phase0/artifacts");

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
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

async function main(): Promise<void> {
  mkdirSync(artifactDir, { recursive: true });
  const recorder = new ProtocolRecorder(resolve(artifactDir, "opencode-acp.ndjson"));
  const stderr = createWriteStream(resolve(artifactDir, "opencode-acp.stderr.log"));
  const summaryPath = resolve(artifactDir, "opencode-acp-summary.json");
  const result: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    ok: false,
  };

  const child = spawn(
    "C:\\Users\\jjbon\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe",
    ["acp"],
    {
    cwd: fixtureRoot,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  });

  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error("OpenCode ACP missing stdio");
  }
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
      async requestPermission() {
        return { outcome: { outcome: "cancelled" } };
      },
      async sessionUpdate() {},
    };
  }, stream);

  try {
    result.initialize = await withTimeout(
      connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "agent-relay-phase0-opencode", version: "0.1.0" },
      }),
      30000,
      "initialize",
    );
    const session = await withTimeout(
      connection.newSession({ cwd: fixtureRoot, mcpServers: [] }),
      30000,
      "session/new",
    );
    result.sessionId = session.sessionId;
    result.ok = true;
  } catch (error) {
    result.error = error instanceof Error ? error.stack ?? error.message : String(error);
  } finally {
    child.kill("SIGTERM");
    result.processExit = await Promise.race([
      exitPromise,
      new Promise((resolveExit) => {
        setTimeout(() => {
          child.kill("SIGKILL");
          resolveExit({ code: null, signal: "SIGKILL" });
        }, 3000);
      }),
    ]);
    result.finishedAt = new Date().toISOString();
    await recorder.close();
    stderr.end();
    writeFileSync(summaryPath, `${JSON.stringify(result, null, 2)}\n`);
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

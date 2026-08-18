import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { loadDeepseekApiKey } from "./credentials.ts";
import { ProtocolRecorder } from "./recorder.ts";

const here = dirname(fileURLToPath(import.meta.url));
const experimentRoot = resolve(here, "..");
const repoRoot = resolve(experimentRoot, "../..");
const harnessRoot = resolve(repoRoot, "references/deepseek-harness");
const fixtureRoot = resolve(experimentRoot, "fixtures/math-repo");
const artifactDir = resolve(repoRoot, "phase0/artifacts");
const sessionsRoot = resolve(experimentRoot, ".sessions");

type CancelResult = {
  startedAt: string;
  finishedAt?: string;
  ok: boolean;
  error?: string;
  initialize?: unknown;
  sessionId?: string;
  prompt?: unknown;
  cancelledAfterMs?: number;
  processExit?: { code: number | null; signal: NodeJS.Signals | null };
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function main(): Promise<void> {
  mkdirSync(artifactDir, { recursive: true });
  mkdirSync(sessionsRoot, { recursive: true });

  const stderr = createWriteStream(resolve(artifactDir, "deepseek-acp-cancel.stderr.log"));
  const recorder = new ProtocolRecorder(resolve(artifactDir, "deepseek-acp-cancel.ndjson"));
  const summaryPath = resolve(artifactDir, "deepseek-acp-cancel-summary.json");
  const apiKey = loadDeepseekApiKey();
  const result: CancelResult = {
    startedAt: new Date().toISOString(),
    ok: false,
  };

  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      resolve(harnessRoot, "packages/examples/acp-demo/src/bin.ts"),
      "--config",
      resolve(harnessRoot, "examples/acp-agent/cordis.yml"),
    ],
    {
      cwd: harnessRoot,
      env: {
        ...process.env,
        DEEPSEEK_API_KEY: apiKey,
        DSH_HOME: process.env.DSH_HOME ?? resolve(homedir(), ".dsh"),
        DSH_PERMISSION_MODE: "workspace-write",
        DSH_SNAPSHOT_SESSIONS_ROOT: sessionsRoot,
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: false,
    },
  );

  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error("ACP child missing stdio pipes");
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
      async requestPermission(params) {
        const selected =
          params.options.find((option) => option.kind === "allow_once") ?? params.options[0];
        if (!selected) return { outcome: { outcome: "cancelled" } };
        return { outcome: { outcome: "selected", optionId: selected.optionId } };
      },
      async sessionUpdate() {},
    };
  }, stream);

  try {
    result.initialize = await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "agent-relay-phase0-cancel", version: "0.1.0" },
    });
    const session = await connection.newSession({ cwd: fixtureRoot, mcpServers: [] });
    result.sessionId = session.sessionId;

    const promptPromise = connection.prompt({
      sessionId: session.sessionId,
      prompt: [
        {
          type: "text",
          text: [
            "Work in this repository.",
            "Read src/math.ts and tests/math.test.ts thoroughly.",
            "Then propose a detailed refactor plan with at least 20 numbered steps.",
            "Do not finish in the first second; inspect files before answering.",
            "Do not commit.",
          ].join("\n"),
        },
      ],
    });

    await sleep(2500);
    const cancelAt = Date.now();
    await connection.cancel({ sessionId: session.sessionId });
    result.cancelledAfterMs = Date.now() - Date.parse(result.startedAt);
    result.prompt = await promptPromise;
    result.ok =
      typeof result.prompt === "object" &&
      result.prompt !== null &&
      "stopReason" in result.prompt &&
      (result.prompt as { stopReason?: string }).stopReason === "cancelled";
    if (!result.ok) {
      result.error = `expected stopReason=cancelled after ${Date.now() - cancelAt}ms, got ${JSON.stringify(result.prompt)}`;
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

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

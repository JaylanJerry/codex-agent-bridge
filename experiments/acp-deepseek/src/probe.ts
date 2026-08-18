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

const TURN_TIMEOUT_MS = 12 * 60 * 1000;

type ProbeResult = {
  startedAt: string;
  finishedAt?: string;
  ok: boolean;
  error?: string;
  initialize?: unknown;
  sessionId?: string;
  firstPrompt?: unknown;
  secondPrompt?: unknown;
  permissionRequests: unknown[];
  sessionUpdates: number;
  processExit?: { code: number | null; signal: NodeJS.Signals | null };
};

function choosePermissionOption(
  options: acp.PermissionOption[],
): acp.PermissionOption | undefined {
  return (
    options.find((option) => option.optionId.includes("allow_once")) ??
    options.find((option) => option.kind === "allow_once") ??
    options.find((option) => option.kind === "allow_always") ??
    options[0]
  );
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${TURN_TIMEOUT_MS}ms`)),
          TURN_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  mkdirSync(artifactDir, { recursive: true });
  mkdirSync(sessionsRoot, { recursive: true });

  const stderrPath = resolve(artifactDir, "deepseek-acp.stderr.log");
  const summaryPath = resolve(artifactDir, "deepseek-acp-summary.json");
  const recorder = new ProtocolRecorder(resolve(artifactDir, "deepseek-acp.ndjson"));
  const stderr = createWriteStream(stderrPath, { encoding: "utf8" });
  const apiKey = loadDeepseekApiKey();

  const result: ProbeResult = {
    startedAt: new Date().toISOString(),
    ok: false,
    permissionRequests: [],
    sessionUpdates: 0,
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
    (resolveExit) => {
      child.on("exit", (code, signal) => resolveExit({ code, signal }));
    },
  );

  recorder.tapWritable(child.stdin);
  const tappedStdout = recorder.tapReadable(child.stdout);

  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin),
    Readable.toWeb(tappedStdout) as ReadableStream<Uint8Array>,
  );

  const connection = new acp.ClientSideConnection(() => {
    return {
      async requestPermission(params) {
        result.permissionRequests.push({
          timestamp: new Date().toISOString(),
          toolCall: params.toolCall,
          options: params.options,
        });
        const selected = choosePermissionOption(params.options);
        if (!selected) {
          return { outcome: { outcome: "cancelled" } };
        }
        return {
          outcome: {
            outcome: "selected",
            optionId: selected.optionId,
          },
        };
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
        clientInfo: { name: "agent-relay-phase0", version: "0.1.0" },
      }),
      "initialize",
    );

    const session = await withTimeout(
      connection.newSession({
        cwd: fixtureRoot,
        mcpServers: [],
      }),
      "session/new",
    );
    result.sessionId = session.sessionId;

    result.firstPrompt = await withTimeout(
      connection.prompt({
        sessionId: session.sessionId,
        prompt: [
          {
            type: "text",
            text: [
              "You are working in this repository.",
              "src/math.ts currently has a bug: add(a, b) wrongly returns a - b.",
              "Fix add so it returns a + b, and add negative-number tests.",
              "Keep sub() behavior unchanged.",
              "Run the existing tests after the change.",
              "Do not commit.",
            ].join("\n"),
          },
        ],
      }),
      "first prompt",
    );

    result.secondPrompt = await withTimeout(
      connection.prompt({
        sessionId: session.sessionId,
        prompt: [
          {
            type: "text",
            text: [
              "Keep the existing exported API.",
              "Rewrite tests/math.test.ts into a table-driven form covering positives, negatives, and zeros.",
              "Run the tests.",
              "Do not commit.",
            ].join("\n"),
          },
        ],
      }),
      "second prompt",
    );

    result.ok = true;
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

  if (!result.ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

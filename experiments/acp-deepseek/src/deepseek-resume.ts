import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  artifactDir,
  fixtureRoot,
  printAndExit,
  repoRoot,
  runAcpSession,
  spawnAgent,
  withTimeout,
} from "./acp-session.ts";
import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { ProtocolRecorder } from "./recorder.ts";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { loadDeepseekApiKey } from "./credentials.ts";

const harnessRoot = resolve(repoRoot, "references/deepseek-harness");
const command = process.execPath;
const args = [
  "--import",
  "tsx",
  resolve(harnessRoot, "packages/examples/acp-demo/src/bin.ts"),
  "--config",
  resolve(harnessRoot, "examples/acp-agent/cordis.yml"),
];
const env = {
  DEEPSEEK_API_KEY: loadDeepseekApiKey(),
  DSH_HOME: process.env.DSH_HOME ?? resolve(homedir(), ".dsh"),
  DSH_PERMISSION_MODE: "workspace-write",
  DSH_SNAPSHOT_SESSIONS_ROOT: resolve(artifactDir, "../..", "experiments/acp-deepseek/.sessions"),
};

const first = await runAcpSession({
  name: "deepseek-acp-resume-first",
  command,
  args,
  cwd: harnessRoot,
  env,
  promptText: "Reply with exactly PONG. Do not edit files or run commands.",
  timeoutMs: 180000,
});

if (!first.ok || !first.sessionId) {
  printAndExit({ ...first, error: first.error ?? "first session failed" });
} else {
  mkdirSync(artifactDir, { recursive: true });
  const recorder = new ProtocolRecorder(resolve(artifactDir, "deepseek-acp-resume-load.ndjson"));
  const stderr = createWriteStream(resolve(artifactDir, "deepseek-acp-resume-load.stderr.log"));
  const child = spawnAgent(command, args, harnessRoot, env);
  child.stderr.on("data", (chunk: Buffer) => {
    stderr.write(chunk);
    process.stderr.write(chunk);
  });
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
  let coldResume: { ok: boolean; error?: string; result?: unknown };
  try {
    await withTimeout(
      connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "agent-relay-deepseek-resume", version: "0.1.0" },
      }),
      60000,
      "initialize",
    );
    const loaded = await withTimeout(
      connection.loadSession({
        sessionId: first.sessionId,
        cwd: fixtureRoot,
        mcpServers: [],
      }),
      30000,
      "session/load",
    );
    coldResume = { ok: true, result: loaded };
  } catch (error) {
    coldResume = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    child.kill("SIGTERM");
    await recorder.close();
    stderr.end();
  }
  const summary = {
    startedAt: first.startedAt,
    finishedAt: new Date().toISOString(),
    ok: true,
    firstSessionId: first.sessionId,
    firstPrompt: first.prompt,
    coldResume,
  };
  writeFileSync(
    resolve(artifactDir, "deepseek-acp-resume-summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

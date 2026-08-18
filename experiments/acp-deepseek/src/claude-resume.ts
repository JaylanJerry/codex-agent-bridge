import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import {
  artifactDir,
  fixtureRoot,
  printAndExit,
  runAcpSession,
  spawnAgent,
  withTimeout,
} from "./acp-session.ts";
import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { ProtocolRecorder } from "./recorder.ts";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { loadDeepseekApiKey } from "./credentials.ts";

async function tryLoad(opts: {
  name: string;
  command: string;
  args: string[];
  sessionId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ ok: boolean; error?: string; result?: unknown }> {
  mkdirSync(artifactDir, { recursive: true });
  const recorder = new ProtocolRecorder(resolve(artifactDir, `${opts.name}.ndjson`));
  const stderr = createWriteStream(resolve(artifactDir, `${opts.name}.stderr.log`));
  const child = spawnAgent(opts.command, opts.args, fixtureRoot, opts.env);
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
  try {
    await withTimeout(
      connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: `agent-relay-${opts.name}`, version: "0.1.0" },
      }),
      60000,
      "initialize",
    );
    const loaded = await withTimeout(
      connection.loadSession({
        sessionId: opts.sessionId,
        cwd: fixtureRoot,
        mcpServers: [],
      }),
      30000,
      "session/load",
    );
    return { ok: true, result: loaded };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    child.kill("SIGTERM");
    await recorder.close();
    stderr.end();
  }
}

const claudeAdapter = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../acp-claude/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js",
);

const first = await runAcpSession({
  name: "claude-acp-resume-first",
  command: process.execPath,
  args: [claudeAdapter],
  promptText: "Reply with exactly PONG. Do not edit files.",
  timeoutMs: 120000,
});

if (!first.ok || !first.sessionId) {
  printAndExit({ ...first, error: first.error ?? "first session failed" });
} else {
  const loaded = await tryLoad({
    name: "claude-acp-resume-load",
    command: process.execPath,
    args: [claudeAdapter],
    sessionId: first.sessionId,
  });
  const summary = {
    startedAt: first.startedAt,
    finishedAt: new Date().toISOString(),
    ok: true,
    firstSessionId: first.sessionId,
    firstPrompt: first.prompt,
    coldResume: loaded,
  };
  writeFileSync(resolve(artifactDir, "claude-acp-resume-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

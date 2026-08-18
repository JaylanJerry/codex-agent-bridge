import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { printAndExit, runAcpSession } from "./acp-session.ts";

const adapter = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../acp-claude/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js",
);

if (!existsSync(adapter)) {
  throw new Error(`Claude ACP adapter missing: ${adapter}`);
}

const result = await runAcpSession({
  name: "claude-acp",
  command: process.execPath,
  args: [adapter],
  promptText:
    "Reply with exactly PONG. Do not edit files, do not run commands, do not call tools.",
  timeoutMs: 180_000,
});

printAndExit(result);

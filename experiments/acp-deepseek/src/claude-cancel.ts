import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { printAndExit, runAcpSession } from "./acp-session.ts";

const adapter = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../acp-claude/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js",
);

const result = await runAcpSession({
  name: "claude-acp-cancel",
  command: process.execPath,
  args: [adapter],
  promptText:
    "Read src/math.ts and tests/math.test.ts, then write a 30-step refactor plan. Do not finish immediately. Do not commit.",
  cancelAfterMs: 2500,
  timeoutMs: 120_000,
});

printAndExit(result);

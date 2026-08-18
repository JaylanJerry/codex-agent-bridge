import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { printAndExit, runAcpSession } from "./acp-session.ts";

const adapter = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../acp-claude/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js",
);

const result = await runAcpSession({
  name: "claude-acp-two-turn",
  command: process.execPath,
  args: [adapter],
  promptText: [
    "You are working in this repository.",
    "src/math.ts currently has a bug: add(a, b) wrongly returns a - b.",
    "Fix add so it returns a + b, and add negative-number tests.",
    "Keep sub() behavior unchanged.",
    "Run the existing tests after the change.",
    "Do not commit.",
  ].join("\n"),
  secondPromptText: [
    "Keep the existing exported API.",
    "Rewrite tests/math.test.ts into a table-driven form covering positives, negatives, and zeros.",
    "Run the tests.",
    "Do not commit.",
  ].join("\n"),
  timeoutMs: 12 * 60 * 1000,
});

printAndExit(result);

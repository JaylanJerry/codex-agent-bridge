import { printAndExit, runAcpSession } from "./acp-session.ts";

const opencode = "C:\\Users\\jjbon\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe";

const prompt = await runAcpSession({
  name: "opencode-acp-prompt",
  command: opencode,
  args: ["acp"],
  promptText:
    "Reply with exactly PONG. Do not edit files, do not run commands, do not call tools.",
  timeoutMs: 180_000,
});

if (!prompt.ok) {
  printAndExit(prompt);
}

const cancel = await runAcpSession({
  name: "opencode-acp-cancel",
  command: opencode,
  args: ["acp"],
  promptText:
    "Inspect src/math.ts and tests/math.test.ts, then write a 30-step refactor plan. Do not finish immediately. Do not commit.",
  cancelAfterMs: 2500,
  timeoutMs: 120_000,
});

printAndExit({
  startedAt: prompt.startedAt,
  finishedAt: cancel.finishedAt,
  ok: Boolean(prompt.ok && cancel.ok),
  error: cancel.ok ? prompt.error : cancel.error,
  initialize: prompt.initialize,
  sessionId: prompt.sessionId,
  prompt: prompt.prompt,
  cancelPrompt: cancel.cancelPrompt,
  permissionRequests: [
    ...prompt.permissionRequests,
    ...cancel.permissionRequests,
  ],
  sessionUpdates: prompt.sessionUpdates + cancel.sessionUpdates,
  processExit: cancel.processExit,
});

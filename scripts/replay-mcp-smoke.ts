import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { McpStdioClient } from "../src/mcp/client.ts";
import type { BridgeResult } from "../src/api/client.ts";

function git(cwd: string, args: string[]) {
  const proc = spawnSync("git", ["-c", "core.longpaths=true", ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  if (proc.status !== 0) throw new Error(proc.stderr || proc.stdout);
  return proc.stdout.trim();
}

const root = mkdtempSync(join(tmpdir(), "ab-mcp-smoke-"));
git(root, ["init"]);
git(root, ["config", "user.name", "t"]);
git(root, ["config", "user.email", "t@t"]);
writeFileSync(join(root, "src.ts"), "export const v = 1;\n");
git(root, ["add", "."]);
git(root, ["commit", "-m", "init"]);
const base = git(root, ["rev-parse", "HEAD"]);

const client = new McpStdioClient();
try {
  const init = (await client.initialize()) as { serverInfo?: { name: string } };
  const listed = (await client.request("tools/list")) as { tools: { name: string }[] };
  const run = await client.callTool("bridge_run", {
    project: root,
    objective: "bump v",
    worker: "replay",
    files: { "src.ts": "export const v = 2;\n" },
    clientRequestId: "mcp-smoke",
  });
  const first = run.structuredContent as BridgeResult;
  const continued = await client.callTool("bridge_continue", {
    project: root,
    task: first.task!.taskId,
    notes: "add note",
    stateVersion: first.task!.stateVersion,
    files: { "note.md": "revised\n" },
  });
  const second = continued.structuredContent as BridgeResult;
  const approved = await client.callTool("bridge_approve", {
    project: root,
    task: second.task!.taskId,
    stateVersion: second.task!.stateVersion,
  });
  const done = approved.structuredContent as BridgeResult;
  const summary = {
    ok: done.task?.state === "COMPLETED" && git(root, ["rev-parse", "HEAD"]) === base,
    server: init.serverInfo?.name,
    tools: listed.tools.map((tool) => tool.name),
    taskId: done.task?.taskId,
    state: done.task?.state,
    approvedCommit: done.task?.approvedCommit,
    mainHeadUnchanged: git(root, ["rev-parse", "HEAD"]) === base,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exit(1);
} finally {
  client.close();
  rmSync(root, { recursive: true, force: true });
}

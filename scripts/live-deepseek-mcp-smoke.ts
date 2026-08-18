import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { McpStdioClient } from "../src/mcp/client.ts";
import type { BridgeResult } from "../src/api/client.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = join(repoRoot, "experiments/acp-deepseek/fixtures/math-repo");

function git(cwd: string, args: string[]) {
  const proc = spawnSync("git", ["-c", "core.longpaths=true", ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  if (proc.status !== 0) throw new Error(proc.stderr || proc.stdout);
  return proc.stdout.trim();
}

const root = mkdtempSync(join(tmpdir(), "ab-dsh-mcp-"));
cpSync(fixture, root, { recursive: true });
git(root, ["init"]);
git(root, ["config", "user.name", "t"]);
git(root, ["config", "user.email", "t@t"]);
git(root, ["add", "."]);
git(root, ["commit", "-m", "init"]);
const base = git(root, ["rev-parse", "HEAD"]);

const client = new McpStdioClient();
try {
  await client.initialize();
  const run = await client.callTool("bridge_run", {
    project: root,
    worker: "deepseek",
    clientRequestId: `dsh-mcp-${Date.now()}`,
    timeoutMs: 600_000,
    objective:
      "Fix src/math.ts add() so it returns a+b. Do not commit, push, or change sub(). Stop after the file is fixed.",
  });
  const first = run.structuredContent as BridgeResult;
  if (!first.ok || first.task?.state !== "AWAITING_REVIEW") {
    const journal = join(root, ".agent-bridge-data", "journal.ndjson");
    let events: unknown[] = [];
    try {
      events = readFileSync(journal, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      // missing journal
    }
    console.log(JSON.stringify({ ok: false, stage: "run", first, events }, null, 2));
    process.exit(1);
  }
  const worktreeMath = first.task.worktreePath
    ? readFileSync(join(first.task.worktreePath, "src/math.ts"), "utf8")
    : "";
  const approved = await client.callTool("bridge_approve", {
    project: root,
    task: first.task.taskId,
    stateVersion: first.task.stateVersion,
  });
  const done = approved.structuredContent as BridgeResult;
  const summary = {
    ok: done.task?.state === "COMPLETED" && worktreeMath.includes("a + b") && git(root, ["rev-parse", "HEAD"]) === base,
    worker: "deepseek",
    taskId: done.task?.taskId,
    state: done.task?.state,
    stopReason: first.task.lastStopReason,
    changedFiles: first.reviewPacket?.changedFiles,
    approvedCommit: done.task?.approvedCommit,
    mainHeadUnchanged: git(root, ["rev-parse", "HEAD"]) === base,
    addLooksFixed: worktreeMath.includes("a + b"),
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exit(1);
} finally {
  client.close();
  rmSync(root, { recursive: true, force: true });
}

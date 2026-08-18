import { test } from "node:test";
import assert from "node:assert/strict";
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

test("MCP and CLI share Core: run, continue, approve via structured tools", async () => {
  const root = mkdtempSync(join(tmpdir(), "ab-mcp-"));
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
    assert.equal(init.serverInfo?.name, "agent-bridge");
    const listed = (await client.request("tools/list")) as { tools: { name: string }[] };
    assert.ok(listed.tools.some((tool) => tool.name === "bridge_run"));
    assert.ok(listed.tools.some((tool) => tool.name === "bridge_apply"));
    assert.ok(listed.tools.some((tool) => tool.name === "bridge_doctor"));
    assert.ok(listed.tools.some((tool) => tool.name === "bridge_agents"));

    const doctor = await client.callTool("bridge_doctor", {});
    const doctorResult = doctor.structuredContent as BridgeResult;
    assert.equal(doctor.isError, false);
    assert.ok(doctorResult.version);
    assert.ok((doctorResult.checks ?? []).some((check) => check.id === "git"));

    const run = await client.callTool("bridge_run", {
      project: root,
      objective: "bump v",
      worker: "replay",
      files: { "src.ts": "export const v = 2;\n" },
      clientRequestId: "mcp-1",
    });
    const first = run.structuredContent as BridgeResult;
    assert.equal(run.isError, false);
    assert.equal(first.task?.state, "AWAITING_REVIEW");
    assert.ok(first.reviewPacket?.changedFiles.some((file) => file.path.replaceAll("\\", "/") === "src.ts"));

    const continued = await client.callTool("bridge_continue", {
      project: root,
      task: first.task!.taskId,
      notes: "add note",
      stateVersion: first.task!.stateVersion,
      files: { "note.md": "revised\n" },
    });
    const second = continued.structuredContent as BridgeResult;
    assert.equal(second.task?.state, "AWAITING_REVIEW");

    const approved = await client.callTool("bridge_approve", {
      project: root,
      task: second.task!.taskId,
      stateVersion: second.task!.stateVersion,
    });
    const done = approved.structuredContent as BridgeResult;
    assert.equal(done.task?.state, "COMPLETED");
    assert.ok(done.task?.approvedCommit);
    assert.equal(git(root, ["rev-parse", "HEAD"]), base);
    const applied = await client.callTool("bridge_apply", {
      project: root,
      task: done.task!.taskId,
      stateVersion: done.task!.stateVersion,
    });
    const landed = applied.structuredContent as BridgeResult;
    assert.equal(applied.isError, false);
    assert.equal(git(root, ["rev-parse", "HEAD"]), landed.task?.appliedHead);
    assert.notEqual(landed.task?.appliedHead, base);

    const status = await client.callTool("bridge_status", { project: root, needsAttention: true });
    const listedTasks = status.structuredContent as BridgeResult;
    assert.equal((listedTasks.tasks ?? []).length, 0);
  } finally {
    client.close();
    rmSync(root, { recursive: true, force: true });
  }
});

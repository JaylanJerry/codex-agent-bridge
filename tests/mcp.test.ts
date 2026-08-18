import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    assert.ok(listed.tools.some((tool) => tool.name === "bridge_prune"));
    assert.ok(listed.tools.some((tool) => tool.name === "bridge_respond"));

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

test("MCP permission gate keeps the live waiter across bridge_respond", async () => {
  const root = mkdtempSync(join(tmpdir(), "ab-mcp-perm-"));
  git(root, ["init"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["config", "user.email", "t@t"]);
  writeFileSync(join(root, "README.md"), "base\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "init"]);

  const client = new McpStdioClient();
  try {
    await client.initialize();
    const run = await client.callTool("bridge_run", {
      project: root,
      objective: "ASK_PERMISSION\nWRITE gated.ts\nexport const n = 1;\n",
      worker: "fake",
      clientRequestId: "mcp-perm-1",
      timeoutMs: 20_000,
    });
    const paused = run.structuredContent as BridgeResult;
    assert.equal(run.isError, false);
    assert.equal(paused.task?.state, "WAITING_FOR_INPUT");
    assert.equal(paused.reviewPacket, undefined);
    assert.ok(
      paused.task?.pendingInput?.options.some((option) => option.optionId === "allow-once"),
    );

    const responded = await client.callTool("bridge_respond", {
      project: root,
      task: paused.task!.taskId,
      stateVersion: paused.task!.stateVersion,
      optionId: "allow-once",
      timeoutMs: 20_000,
    });
    const reviewed = responded.structuredContent as BridgeResult;
    assert.equal(responded.isError, false);
    assert.equal(reviewed.task?.state, "AWAITING_REVIEW");
    assert.ok(
      reviewed.reviewPacket?.changedFiles.some(
        (file) => file.path.replaceAll("\\", "/") === "gated.ts",
      ),
    );

    const cancelled = await client.callTool("bridge_cancel", {
      project: root,
      task: reviewed.task!.taskId,
      stateVersion: reviewed.task!.stateVersion,
    });
    assert.equal((cancelled.structuredContent as BridgeResult).task?.state, "CANCELLED");
  } finally {
    client.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("MCP hydrates leftover RUNNING into AWAITING_REVIEW and persists it", async () => {
  const root = mkdtempSync(join(tmpdir(), "ab-mcp-hyd-"));
  git(root, ["init"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["config", "user.email", "t@t"]);
  writeFileSync(join(root, "README.md"), "base\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "init"]);
  mkdirSync(join(root, ".agent-bridge-data"), { recursive: true });
  writeFileSync(
    join(root, ".agent-bridge-data", "tasks.json"),
    `${JSON.stringify(
      {
        tasks: [
          {
            taskId: "dead-run",
            clientRequestId: "hyd-1",
            state: "RUNNING",
            stateVersion: 4,
            verdict: null,
            interrupted: false,
            objective: "x",
            projectPath: root,
            workerId: "replay",
            sessionId: "replay-old",
          },
        ],
        byRequest: [["hyd-1", "dead-run"]],
        reviewHashes: [],
      },
      null,
      2,
    )}\n`,
  );

  const client = new McpStdioClient();
  try {
    await client.initialize();
    const status = await client.callTool("bridge_status", { project: root, needsAttention: true });
    const listed = status.structuredContent as BridgeResult;
    assert.equal(status.isError, false);
    assert.equal(listed.tasks?.length, 1);
    assert.equal(listed.tasks?.[0]?.state, "AWAITING_REVIEW");
    assert.equal(listed.tasks?.[0]?.interrupted, true);
    assert.equal(listed.tasks?.[0]?.sessionId, "replay-old");
    const saved = JSON.parse(readFileSync(join(root, ".agent-bridge-data", "tasks.json"), "utf8")) as {
      tasks: { state: string; interrupted: boolean }[];
    };
    assert.equal(saved.tasks[0]?.state, "AWAITING_REVIEW");
    assert.equal(saved.tasks[0]?.interrupted, true);
  } finally {
    client.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("MCP required args: missing project/task is explicit; taskId alias works", async () => {
  const root = mkdtempSync(join(tmpdir(), "ab-mcp-args-"));
  git(root, ["init"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["config", "user.email", "t@t"]);
  writeFileSync(join(root, "README.md"), "base\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "init"]);
  mkdirSync(join(root, ".agent-bridge-data"), { recursive: true });
  writeFileSync(
    join(root, ".agent-bridge-data", "tasks.json"),
    `${JSON.stringify(
      {
        tasks: [
          {
            taskId: "dead-run",
            clientRequestId: "hyd-args",
            state: "RUNNING",
            stateVersion: 4,
            verdict: null,
            interrupted: false,
            objective: "x",
            projectPath: root,
            workerId: "replay",
          },
        ],
        byRequest: [["hyd-args", "dead-run"]],
        reviewHashes: [],
      },
      null,
      2,
    )}\n`,
  );

  const client = new McpStdioClient();
  try {
    await client.initialize();
    const noProject = await client.callTool("bridge_status", {});
    assert.equal(noProject.isError, true);
    assert.match(String((noProject.structuredContent as BridgeResult).error), /missing project/);

    const noTask = await client.callTool("bridge_respond", {
      project: root,
      stateVersion: 4,
      optionId: "allow",
    });
    assert.equal(noTask.isError, true);
    assert.match(String((noTask.structuredContent as BridgeResult).error), /missing task/);

    const viaAlias = await client.callTool("bridge_status", { project: root, taskId: "dead-run" });
    const listed = viaAlias.structuredContent as BridgeResult;
    assert.equal(viaAlias.isError, false);
    assert.equal(listed.task?.taskId, "dead-run");
    assert.equal(listed.task?.state, "AWAITING_REVIEW");
  } finally {
    client.close();
    rmSync(root, { recursive: true, force: true });
  }
});

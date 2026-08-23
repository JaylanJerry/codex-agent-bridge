import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { McpStdioClient } from "../../src/mcp/client.ts";
import type { BridgeResult } from "../../src/api/client.ts";
import { listAgentBridgeWorktrees } from "../../src/workspace/worktree.ts";

function git(cwd: string, args: string[]) {
  const proc = spawnSync("git", ["-c", "core.longpaths=true", ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  if (proc.status !== 0) throw new Error(proc.stderr || proc.stdout);
  return proc.stdout.trim();
}

test("golden path: empty repo hello-world through permission, verify, review, approve, apply", async () => {
  const root = mkdtempSync(join(tmpdir(), "ab-e2e-hello-"));
  git(root, ["init"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["config", "user.email", "t@t"]);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "test-project", type: "module" }));
  mkdirSync(join(root, ".agent-bridge"), { recursive: true });
  writeFileSync(
    join(root, ".agent-bridge", "verify.json"),
    JSON.stringify({
      schemaVersion: "1.0",
      commands: {
        hello: { exe: "node", args: ["--test", "hello.test.js"], timeoutMs: 30_000 },
      },
    }),
  );
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "init empty project"]);
  const base = git(root, ["rev-parse", "HEAD"]);

  const client = new McpStdioClient();
  try {
    await client.initialize();
    const run = await client.callTool("bridge_run", {
      project: root,
      objective: "ASK_PERMISSION\nWRITE hello.js\nexport function hello() { return \"world\"; }\n",
      worker: "fake",
      clientRequestId: "e2e-hello",
      timeoutMs: 30_000,
    });
    const paused = run.structuredContent as BridgeResult;
    assert.equal(run.isError, false);
    assert.equal(paused.task?.state, "WAITING_FOR_INPUT");
    assert.ok(paused.task?.worktreePath);
    assert.equal(existsSync(paused.task.worktreePath), true);
    assert.equal(git(root, ["rev-parse", "HEAD"]), base);

    const optionId = paused.task.pendingInput?.options.find((option) => option.optionId.includes("allow"))?.optionId;
    assert.ok(optionId);
    const responded = await client.callTool("bridge_respond", {
      project: root,
      task: paused.task.taskId,
      stateVersion: paused.task.stateVersion,
      optionId,
      timeoutMs: 30_000,
    });
    const firstReview = responded.structuredContent as BridgeResult;
    assert.equal(firstReview.task?.state, "AWAITING_REVIEW");
    assert.equal(existsSync(join(firstReview.task!.worktreePath!, "hello.js")), true);
    assert.equal(firstReview.reviewPacket?.verification?.passed, false);
    assert.equal(git(root, ["rev-parse", "HEAD"]), base);

    const continued = await client.callTool("bridge_continue", {
      project: root,
      task: firstReview.task!.taskId,
      stateVersion: firstReview.task!.stateVersion,
      notes: "WRITE hello.test.js\nimport { test } from \"node:test\";\nimport assert from \"node:assert/strict\";\nimport { hello } from \"./hello.js\";\ntest(\"hello\", () => assert.equal(hello(), \"world\"));\n",
      timeoutMs: 30_000,
    });
    const secondReview = continued.structuredContent as BridgeResult;
    assert.equal(secondReview.task?.state, "AWAITING_REVIEW");
    assert.equal(secondReview.reviewPacket?.verification?.passed, true);
    assert.ok(secondReview.reviewPacket?.changedFiles.some((file) => file.path.replaceAll("\\", "/") === "hello.js"));
    assert.ok(
      secondReview.reviewPacket?.changedFiles.some((file) => file.path.replaceAll("\\", "/") === "hello.test.js"),
    );
    assert.equal(git(root, ["rev-parse", "HEAD"]), base);

    const approved = await client.callTool("bridge_approve", {
      project: root,
      task: secondReview.task!.taskId,
      stateVersion: secondReview.task!.stateVersion,
    });
    const done = approved.structuredContent as BridgeResult;
    assert.equal(done.task?.state, "COMPLETED");
    assert.ok(done.task?.approvedCommit);
    assert.equal(done.task?.worktreePath, undefined);
    assert.equal(git(root, ["rev-parse", "HEAD"]), base);
    assert.equal(git(root, ["log", "-1", "--format=%P", done.task!.approvedCommit!]), base);
    assert.equal(listAgentBridgeWorktrees(root).length, 0);

    const applied = await client.callTool("bridge_apply", {
      project: root,
      task: done.task!.taskId,
      stateVersion: done.task!.stateVersion,
    });
    const landed = applied.structuredContent as BridgeResult;
    assert.equal(applied.isError, false);
    assert.equal(git(root, ["rev-parse", "HEAD"]), landed.task?.appliedHead);
    assert.notEqual(landed.task?.appliedHead, base);
    assert.match(readFileSync(join(root, "hello.js"), "utf8"), /export function hello/);
    assert.match(readFileSync(join(root, "hello.test.js"), "utf8"), /hello\(\)/);
    assert.equal(listAgentBridgeWorktrees(root).length, 0);
  } finally {
    client.close();
    rmSync(root, { recursive: true, force: true });
  }
});

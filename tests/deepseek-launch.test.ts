import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  requireDeepSeekWorkerLaunch,
  resolveDeepSeekLaunch,
  resolveOfficialDeepSeekAcpRuntime,
} from "../src/workers/deepseek-launch.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const banned = /(?:^|\s)--(?:model|provider|effort|thinking)(?:\s|=|$)/i;

function fakeHarness(): string {
  const root = mkdtempSync(join(tmpdir(), "ab-dsh-launch-"));
  mkdirSync(join(root, "packages/examples/acp-demo/src"), { recursive: true });
  mkdirSync(join(root, "examples/acp-agent"), { recursive: true });
  writeFileSync(join(root, "packages/examples/acp-demo/src/bin.ts"), "export {}\n");
  writeFileSync(join(root, "examples/acp-agent/cordis.yml"), "[]\n");
  return root;
}

test("official ACP runtime placeholder stays unresolved", () => {
  assert.equal(resolveOfficialDeepSeekAcpRuntime(), undefined);
});

test("legacy launch keeps the source example ACP command", () => {
  const root = fakeHarness();
  const previousRoot = process.env.AGENT_BRIDGE_DEEPSEEK_ROOT;
  const previousKey = process.env.DEEPSEEK_API_KEY;
  process.env.AGENT_BRIDGE_DEEPSEEK_ROOT = root;
  process.env.DEEPSEEK_API_KEY = "test-not-a-secret";
  try {
    const resolved = resolveDeepSeekLaunch(repoRoot);
    assert.equal(resolved.type, "legacy");
    if (resolved.type !== "legacy") throw new Error("expected legacy");
    assert.equal(resolved.cwd, root);
    assert.ok(resolved.args.includes(join(root, "packages/examples/acp-demo/src/bin.ts")));
    assert.ok(resolved.args.includes(join(root, "examples/acp-agent/cordis.yml")));
    assert.equal(banned.test([resolved.command, ...resolved.args].join(" ")), false);
    assert.deepEqual(Object.keys(resolved.env ?? {}).sort(), ["DEEPSEEK_API_KEY", "NODE_PATH"]);
    const launch = requireDeepSeekWorkerLaunch(repoRoot);
    assert.equal(launch.command, resolved.command);
    assert.deepEqual(launch.args, resolved.args);
  } finally {
    if (previousRoot === undefined) delete process.env.AGENT_BRIDGE_DEEPSEEK_ROOT;
    else process.env.AGENT_BRIDGE_DEEPSEEK_ROOT = previousRoot;
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousKey;
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing launch stays typed and fail-closed for production start", () => {
  const packageRoot = mkdtempSync(join(tmpdir(), "ab-dsh-launch-missing-"));
  const previousRoot = process.env.AGENT_BRIDGE_DEEPSEEK_ROOT;
  delete process.env.AGENT_BRIDGE_DEEPSEEK_ROOT;
  try {
    assert.deepEqual(resolveDeepSeekLaunch(packageRoot), { type: "missing" });
    assert.throws(
      () => requireDeepSeekWorkerLaunch(packageRoot),
      /DeepSeek Harness ACP demo missing/,
    );
  } finally {
    if (previousRoot === undefined) delete process.env.AGENT_BRIDGE_DEEPSEEK_ROOT;
    else process.env.AGENT_BRIDGE_DEEPSEEK_ROOT = previousRoot;
    rmSync(packageRoot, { recursive: true, force: true });
  }
});

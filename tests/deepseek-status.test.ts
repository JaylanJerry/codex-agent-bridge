import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listAgents } from "../src/core/doctor.ts";
import {
  inspectDeepSeekIntegration,
  resolveOfficialDeepSeekAcpRuntime,
} from "../src/workers/profiles.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fakeHarness(): string {
  const root = mkdtempSync(join(tmpdir(), "ab-dsh-status-"));
  mkdirSync(join(root, "packages/examples/acp-demo/src"), { recursive: true });
  mkdirSync(join(root, "examples/acp-agent"), { recursive: true });
  writeFileSync(join(root, "packages/examples/acp-demo/src/bin.ts"), "export {}\n");
  writeFileSync(join(root, "examples/acp-agent/cordis.yml"), "[]\n");
  return root;
}

test("legacy detected correctly", () => {
  const root = fakeHarness();
  const previous = process.env.AGENT_BRIDGE_DEEPSEEK_ROOT;
  process.env.AGENT_BRIDGE_DEEPSEEK_ROOT = root;
  try {
    const report = inspectDeepSeekIntegration(repoRoot);
    assert.equal(report.transport, "acp");
    assert.equal(report.integration, "legacy");
    assert.equal(report.runtimePath, root);
    const agent = listAgents(repoRoot).find((item) => item.id === "deepseek");
    assert.match(agent?.detail ?? "", /transport=acp/);
    assert.match(agent?.detail ?? "", /integration=legacy/);
    assert.match(agent?.detail ?? "", /DeepSeek ACP available \(legacy source integration\)/);
    assert.match(agent?.detail ?? "", /official runtime unavailable/);
    assert.equal(/official runtime ready/i.test(agent?.detail ?? ""), false);
  } finally {
    if (previous === undefined) delete process.env.AGENT_BRIDGE_DEEPSEEK_ROOT;
    else process.env.AGENT_BRIDGE_DEEPSEEK_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing detected correctly", () => {
  const packageRoot = mkdtempSync(join(tmpdir(), "ab-dsh-missing-"));
  const previous = process.env.AGENT_BRIDGE_DEEPSEEK_ROOT;
  delete process.env.AGENT_BRIDGE_DEEPSEEK_ROOT;
  try {
    const report = inspectDeepSeekIntegration(packageRoot);
    assert.equal(report.transport, "acp");
    assert.equal(report.integration, "missing");
    const agent = listAgents(packageRoot).find((item) => item.id === "deepseek");
    assert.equal(agent?.available, false);
    assert.match(agent?.detail ?? "", /integration=missing/);
    assert.match(agent?.detail ?? "", /official runtime unavailable/);
    assert.equal(/DeepSeek ACP available \(legacy source integration\)/.test(agent?.detail ?? ""), false);
    assert.equal(/official runtime ready/i.test(agent?.detail ?? ""), false);
  } finally {
    if (previous === undefined) delete process.env.AGENT_BRIDGE_DEEPSEEK_ROOT;
    else process.env.AGENT_BRIDGE_DEEPSEEK_ROOT = previous;
    rmSync(packageRoot, { recursive: true, force: true });
  }
});

test("official placeholder does not claim ready", () => {
  assert.equal(resolveOfficialDeepSeekAcpRuntime(), undefined);
  const agent = listAgents(repoRoot).find((item) => item.id === "deepseek");
  assert.match(agent?.detail ?? "", /official runtime unavailable/);
  assert.equal(/official runtime ready/i.test(agent?.detail ?? ""), false);
  assert.notEqual(inspectDeepSeekIntegration(repoRoot).integration, "official");
});

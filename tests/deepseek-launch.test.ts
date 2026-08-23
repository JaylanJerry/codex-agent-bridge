import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  deepSeekHarnessCandidates,
  inheritedDeepSeekHome,
  inspectDeepSeekLaunch,
  isDeepSeekHarnessRoot,
  resolveDeepSeekLaunch,
  resolveOfficialDeepSeekAcpRuntime,
} from "../src/workers/deepseek-launch.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const banned = /(?:^|\s)--(?:model|provider|effort|thinking)(?:\s|=|$)/i;

function fakeHarness(): string {
  const root = mkdtempSync(join(tmpdir(), "ab-dsh-legacy-"));
  mkdirSync(join(root, "packages/examples/acp-demo/src"), { recursive: true });
  mkdirSync(join(root, "examples/acp-agent"), { recursive: true });
  writeFileSync(join(root, "packages/examples/acp-demo/src/bin.ts"), "export {}\n");
  writeFileSync(join(root, "examples/acp-agent/cordis.yml"), "[]\n");
  return root;
}

test("official ACP runtime is unresolved until Gate A finds a product closure", () => {
  assert.equal(resolveOfficialDeepSeekAcpRuntime(), undefined);
});

test("inheritedDeepSeekHome uses DSH_HOME without reading settings", () => {
  const previous = process.env.DSH_HOME;
  const isolated = join(tmpdir(), "ab-dsh-home-only");
  process.env.DSH_HOME = isolated;
  try {
    assert.equal(inheritedDeepSeekHome(), isolated);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
});

test("legacy source tree is detected only by the example ACP layout", () => {
  const root = fakeHarness();
  try {
    assert.equal(isDeepSeekHarnessRoot(root), true);
    assert.equal(isDeepSeekHarnessRoot(tmpdir()), false);
    assert.ok(deepSeekHarnessCandidates(repoRoot).length >= 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy launch uses source example paths and does not override route", () => {
  const root = fakeHarness();
  const previousRoot = process.env.AGENT_BRIDGE_DEEPSEEK_ROOT;
  const previousKey = process.env.DEEPSEEK_API_KEY;
  process.env.AGENT_BRIDGE_DEEPSEEK_ROOT = root;
  process.env.DEEPSEEK_API_KEY = "test-not-a-secret";
  try {
    const launch = resolveDeepSeekLaunch(repoRoot);
    const argv = [launch.command, ...launch.args].join(" ");
    assert.equal(launch.cwd, root);
    assert.ok(launch.args.includes(join(root, "packages/examples/acp-demo/src/bin.ts")));
    assert.ok(launch.args.includes(join(root, "examples/acp-agent/cordis.yml")));
    assert.equal(banned.test(argv), false);
    assert.deepEqual(Object.keys(launch.env ?? {}).sort(), ["DEEPSEEK_API_KEY", "NODE_PATH"]);
    const report = inspectDeepSeekLaunch(repoRoot);
    assert.equal(report.transport, "acp");
    assert.equal(report.integration, "legacy");
    assert.equal(report.runtimePath, root);
    assert.equal(report.credentials, "present");
    assert.equal(JSON.stringify(report).includes("test-not-a-secret"), false);
  } finally {
    if (previousRoot === undefined) delete process.env.AGENT_BRIDGE_DEEPSEEK_ROOT;
    else process.env.AGENT_BRIDGE_DEEPSEEK_ROOT = previousRoot;
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousKey;
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing official and missing source checkout stay fail-closed", () => {
  const packageRoot = mkdtempSync(join(tmpdir(), "ab-dsh-empty-pkg-"));
  const previousRoot = process.env.AGENT_BRIDGE_DEEPSEEK_ROOT;
  delete process.env.AGENT_BRIDGE_DEEPSEEK_ROOT;
  try {
    const report = inspectDeepSeekLaunch(packageRoot);
    assert.equal(report.integration, "missing");
    assert.equal(report.transport, "acp");
    assert.throws(
      () => resolveDeepSeekLaunch(packageRoot),
      /DeepSeek Harness ACP demo missing/,
    );
  } finally {
    if (previousRoot === undefined) delete process.env.AGENT_BRIDGE_DEEPSEEK_ROOT;
    else process.env.AGENT_BRIDGE_DEEPSEEK_ROOT = previousRoot;
    rmSync(packageRoot, { recursive: true, force: true });
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mergeWorkerEnv } from "../src/runtime/worker-env.ts";
import {
  inheritDeepSeekAcpConfig,
  inheritedDeepSeekHome,
  readDeepSeekUserSelection,
  WORKER_LAUNCH_ENV_ALLOWLIST,
  workerLaunchOverridesConfig,
} from "../src/workers/launch-policy.ts";
import {
  fakeAcpProfile,
  resolveClaudeLaunch,
  resolveDeepSeekLaunch,
} from "../src/workers/profiles.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function sourceOmitsModelField(path: string): void {
  const src = readFileSync(path, "utf8");
  assert.equal(/\bmodel\s*:/.test(src), false, path);
}

test("inheritedDeepSeekHome prefers DSH_HOME then ~/.dsh", () => {
  const previous = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = join("C:", "custom-dsh");
    assert.equal(inheritedDeepSeekHome(), join("C:", "custom-dsh"));
    delete process.env.DSH_HOME;
    assert.equal(inheritedDeepSeekHome(), join(homedir(), ".dsh"));
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
});

test("DeepSeek ACP demo config takes model and effort from DSH settings", () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-dsh-inherit-"));
  writeFileSync(
    join(dir, "settings.yaml"),
    "agent-default-model:\n  provider: deepseek-official\n  model: deepseek-v4-flash\n  reasoningEffort: high\nsecret:\n  apiKey: should-not-be-read\n",
  );
  writeFileSync(
    join(dir, "demo.yml"),
    [
      "- id: llm-deepseek",
      "  config:",
      "    reasoningEffort: max",
      "- id: acp-agent",
      "  config:",
      "    provider: deepseek-official",
      "    model: deepseek-v4-pro",
      "",
    ].join("\n"),
  );
  const dest = join(dir, "out.yml");
  inheritDeepSeekAcpConfig(join(dir, "demo.yml"), dest, readDeepSeekUserSelection(dir));
  const out = readFileSync(dest, "utf8");
  assert.match(out, /id: acp-agent[\s\S]*model: deepseek-v4-flash/);
  assert.equal(/model: deepseek-v4-pro/.test(out), false);
  assert.match(out, /reasoningEffort: high/);
  assert.equal(out.includes("should-not-be-read"), false);
  rmSync(dir, { recursive: true, force: true });
});

test("inherit patches the shipped DeepSeek ACP demo cordis.yml", () => {
  const demo = join(repoRoot, "references/deepseek-harness/examples/acp-agent/cordis.yml");
  if (!existsSync(demo)) return;
  const dest = join(tmpdir(), `ab-dsh-real-${process.pid}.yml`);
  inheritDeepSeekAcpConfig(demo, dest, {
    provider: "deepseek-official",
    model: "deepseek-v4-flash",
    reasoningEffort: "high",
  });
  const out = readFileSync(dest, "utf8");
  assert.match(out, /- id: acp-agent[\s\S]*?\n\s+model: deepseek-v4-flash\b/);
  assert.equal(/\n\s+model: deepseek-v4-pro\b/.test(out), false);
  assert.match(out, /- id: llm-deepseek[\s\S]*?\n\s+reasoningEffort: high\b/);
  rmSync(dest, { force: true });
});

test("mergeWorkerEnv inherits HOME and only applies allowlisted extras", () => {
  const merged = mergeWorkerEnv({ DSH_HOME: join(homedir(), ".dsh") });
  assert.equal(merged.DSH_HOME, join(homedir(), ".dsh"));
  assert.equal(merged.HOME ?? merged.USERPROFILE, process.env.HOME ?? process.env.USERPROFILE);
  if (!process.env.ANTHROPIC_MODEL) assert.equal(merged.ANTHROPIC_MODEL, undefined);
});

test("worker launches inherit persistent config instead of selecting a model", () => {
  sourceOmitsModelField(join(repoRoot, "src/workers/profiles.ts"));
  const driverSrc = readFileSync(join(repoRoot, "src/runtime/acp/driver.ts"), "utf8");
  assert.match(driverSrc, /newSession\(\{/);
  assert.match(driverSrc, /mcpServers:\s*\[\]/);
  assert.equal(/\bmodel\s*:/.test(driverSrc), false);

  const fake = fakeAcpProfile(repoRoot);
  assert.equal(workerLaunchOverridesConfig(fake.launch), false);
  assert.equal(fake.launch.env, undefined);

  try {
    const claude = resolveClaudeLaunch(repoRoot);
    assert.equal(workerLaunchOverridesConfig(claude), false);
    assert.equal(claude.env, undefined);
  } catch (error) {
    if (!String(error).includes("Claude ACP adapter missing")) throw error;
  }

  try {
    const deepseek = resolveDeepSeekLaunch(repoRoot);
    assert.equal(workerLaunchOverridesConfig(deepseek), false);
    assert.equal(deepseek.env?.DSH_HOME, inheritedDeepSeekHome());
    for (const key of Object.keys(deepseek.env ?? {})) {
      assert.equal(WORKER_LAUNCH_ENV_ALLOWLIST.has(key), true, key);
    }
    assert.equal(deepseek.env?.DSH_PERMISSION_MODE, undefined);
    const configFlag = deepseek.args.indexOf("--config");
    assert.equal(configFlag >= 0, true);
    assert.equal(existsSync(deepseek.args[configFlag + 1] ?? ""), true);
  } catch (error) {
    if (
      !String(error).includes("DeepSeek Harness ACP demo missing") &&
      !String(error).includes("DEEPSEEK")
    ) {
      throw error;
    }
  }
});

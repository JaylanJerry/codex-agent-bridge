import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { mergeWorkerEnv } from "../src/runtime/worker-env.ts";
import {
  inheritedDeepSeekHome,
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

test("mergeWorkerEnv inherits HOME and only applies allowlisted extras", () => {
  const merged = mergeWorkerEnv({ DSH_HOME: join(homedir(), ".dsh") });
  assert.equal(merged.DSH_HOME, join(homedir(), ".dsh"));
  assert.equal(merged.HOME ?? merged.USERPROFILE, process.env.HOME ?? process.env.USERPROFILE);
  if (!process.env.ANTHROPIC_MODEL) assert.equal(merged.ANTHROPIC_MODEL, undefined);
});

test("worker launches inherit persistent config instead of selecting a model", () => {
  sourceOmitsModelField(join(repoRoot, "src/workers/profiles.ts"));
  sourceOmitsModelField(join(repoRoot, "src/workers/launch-policy.ts"));
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
  } catch (error) {
    if (
      !String(error).includes("DeepSeek Harness ACP demo missing") &&
      !String(error).includes("DEEPSEEK")
    ) {
      throw error;
    }
  }
});

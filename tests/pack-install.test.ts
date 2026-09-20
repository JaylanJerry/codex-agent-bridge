import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run(command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv) {
  const proc = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    env: env ?? process.env,
    shell: process.platform === "win32" && command === "npm",
  });
  if (proc.status !== 0) {
    throw new Error(proc.stderr || proc.stdout || `${command} ${args.join(" ")} failed`);
  }
  return proc.stdout;
}

test("npm pack install can run doctor", () => {
  const packDir = mkdtempSync(join(tmpdir(), "ab-pack-src-"));
  const installDir = mkdtempSync(join(tmpdir(), "ab-pack-install-"));
  const home = mkdtempSync(join(tmpdir(), "ab-pack-home-"));
  try {
    const packed = run("npm", ["pack", "--pack-destination", packDir], repoRoot)
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .at(-1);
    assert.ok(packed);
    const tgz = packed.includes("codex-agent-bridge") ? join(packDir, packed.split(/[\\/]/).at(-1)!) : join(packDir, packed);
    run("npm", ["install", "--omit=dev", "--no-fund", "--no-audit", tgz], installDir);
    const bin = join(installDir, "node_modules", "codex-agent-bridge", "bin", "codex-agent-bridge.mjs");
    const proc = spawnSync(process.execPath, [bin, "doctor"], {
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        CODEX_HOME: join(home, "codex"),
        AGENT_BRIDGE_HOME: join(home, "bridge"),
      },
    });
    const out = `${proc.stdout}\n${proc.stderr}`;
    assert.equal(/Error:\s*undefined/.test(out), false, out);
    assert.match(out, /Agent Bridge doctor/);
    assert.match(out, /Agent Bridge installed/);
    assert.match(out, /Git available/);
    assert.ok(proc.status === 0 || proc.status === 1, out);
  } finally {
    rmSync(packDir, { recursive: true, force: true });
    rmSync(installDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

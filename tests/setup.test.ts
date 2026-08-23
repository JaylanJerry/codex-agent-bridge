import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { mcpSnippet, stripAgentBridgeMcp, upsertAgentBridgeMcp } from "../src/install/mcp-config.ts";
import { packageRoot } from "../src/paths.ts";

const cli = resolve(dirname(fileURLToPath(import.meta.url)), "../src/cli.ts");

test("MCP toml upsert replaces the previous agent-bridge section and keeps neighbors", () => {
  const previous = `[other]
x = 1

[mcp_servers.agent-bridge]
command = "old"
args = ["old.ts"]

[mcp_servers.agent-bridge.env]
NODE_PATH = "old"

[mcp_servers.keep]
command = "keep"
`;
  const snippet = mcpSnippet({
    node: "C:/node.exe",
    server: "C:/app/src/mcp/server.ts",
    cwd: "C:/app",
    nodePath: "C:/app/node_modules",
  });
  const next = upsertAgentBridgeMcp(previous, snippet);
  assert.match(next, /\[other\]/);
  assert.match(next, /\[mcp_servers\.keep\]/);
  assert.match(next, /C:\/app\/src\/mcp\/server\.ts/);
  assert.equal(next.includes("old.ts"), false);
  const stripped = stripAgentBridgeMcp(next);
  assert.equal(stripped.includes("mcp_servers.agent-bridge"), false);
  assert.match(stripped, /\[mcp_servers\.keep\]/);
});

test("setup --dev writes Skill and MCP under CODEX_HOME without touching the real home", () => {
  const root = mkdtempSync(join(tmpdir(), "ab-setup-"));
  const env = {
    ...process.env,
    CODEX_HOME: join(root, "codex"),
    AGENT_BRIDGE_HOME: join(root, "bridge"),
  };
  const proc = spawnSync(process.execPath, ["--import", "tsx", cli, "setup", "--dev"], {
    encoding: "utf8",
    windowsHide: true,
    env,
  });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
  assert.match(proc.stdout, /Agent Bridge installed/);
  assert.equal(/Error:\s*undefined/.test(proc.stdout), false);
  const skill = join(root, "codex", "skills", "agent-bridge", "SKILL.md");
  const config = join(root, "codex", "config.toml");
  assert.equal(existsSync(skill), true);
  const toml = readFileSync(config, "utf8");
  assert.match(toml, /\[mcp_servers\.agent-bridge\]/);
  assert.match(toml, /server\.ts/);
  assert.equal(toml.includes("npx.cmd"), false);
  assert.equal(existsSync(join(root, "bridge", "node_modules")), false);

  const uninstall = spawnSync(process.execPath, ["--import", "tsx", cli, "uninstall"], {
    encoding: "utf8",
    windowsHide: true,
    env,
  });
  assert.equal(uninstall.status, 0, uninstall.stderr || uninstall.stdout);
  assert.equal(existsSync(skill), false);
  const after = existsSync(config) ? readFileSync(config, "utf8") : "";
  assert.equal(after.includes("mcp_servers.agent-bridge"), false);
  rmSync(root, { recursive: true, force: true });
});

test("packageRoot walks from src to this package", () => {
  assert.equal(packageRoot, resolve(dirname(fileURLToPath(import.meta.url)), ".."));
});

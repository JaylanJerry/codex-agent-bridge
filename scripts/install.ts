import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runDoctor } from "../src/core/doctor.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const writeMcp = process.argv.includes("--write-mcp");

const skillSrc = join(repoRoot, "skills", "agent-bridge", "SKILL.md");
const skillDir = join(homedir(), ".codex", "skills", "agent-bridge");
mkdirSync(skillDir, { recursive: true });
copyFileSync(skillSrc, join(skillDir, "SKILL.md"));
console.log(`Skill installed: ${join(skillDir, "SKILL.md")}`);

const node = process.execPath;
const server = join(repoRoot, "src", "mcp", "server.ts");
const nodeModules = join(repoRoot, "node_modules");
const snippet = `[mcp_servers.agent-bridge]
command = ${JSON.stringify(node)}
args = ["--import", "tsx", ${JSON.stringify(server)}]
cwd = ${JSON.stringify(repoRoot)}
startup_timeout_sec = 30

[mcp_servers.agent-bridge.env]
NODE_PATH = ${JSON.stringify(nodeModules)}
`;

const configPath = join(homedir(), ".codex", "config.toml");
if (writeMcp) {
  mkdirSync(dirname(configPath), { recursive: true });
  const existing = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  if (/\[mcp_servers\.agent-bridge\]/.test(existing)) {
    console.log(`MCP already registered in ${configPath}`);
  } else {
    const prefix = existing.trim().length > 0 && !existing.endsWith("\n") ? "\n\n" : existing ? "\n" : "";
    writeFileSync(configPath, `${existing}${prefix}${snippet}`);
    console.log(`MCP registered in ${configPath}`);
  }
} else {
  console.log("MCP snippet (not written; pass --write-mcp to append if missing):");
  console.log(snippet);
}

console.log(
  "Prerequisite: at least one Worker (Claude Code or DeepSeek Harness) must already run independently, including auth and native model/provider config. Agent Bridge detects this; it does not configure Worker models or third-party providers.",
);

const report = runDoctor({ repoRoot });
for (const check of report.checks) {
  console.log(`${check.ok ? "ok" : "FAIL"}  ${check.id}: ${check.detail}`);
}
for (const agent of report.agents) {
  console.log(`${agent.available ? "ok" : "no "}  worker ${agent.id}: ${agent.detail}`);
}

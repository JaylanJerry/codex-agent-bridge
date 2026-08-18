import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { runDoctor } from "../core/doctor.ts";
import {
  PACKAGE_NAME,
  bridgeHome,
  codexHome,
  installedPackageRoot,
  mcpServerPath,
  packageRoot,
  skillSourcePath,
} from "../paths.ts";
import { nodeModulePath } from "../workers/profiles.ts";
import { mcpSnippet, stripAgentBridgeMcp, upsertAgentBridgeMcp } from "./mcp-config.ts";

export type SetupOptions = {
  dev?: boolean;
  writeMcp?: boolean;
  printOnly?: boolean;
  uninstall?: boolean;
  purge?: boolean;
};

function findNpmCli(): string | undefined {
  const fromEnv = process.env.npm_execpath;
  const candidates = [
    fromEnv,
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  return candidates.find((item): item is string => Boolean(item && existsSync(item)));
}

function npm(args: string[], cwd?: string) {
  const npmCli = findNpmCli();
  if (!npmCli) {
    throw new Error("npm CLI not found next to node.exe. Install Node.js with npm, then retry.");
  }
  const proc = spawnSync(process.execPath, [npmCli, ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  if (proc.status !== 0) {
    throw new Error((proc.stderr || proc.stdout || `npm ${args.join(" ")} failed`).trim());
  }
  return proc.stdout;
}

export function materializeInstall(source: string, home = bridgeHome()): string {
  const dest = installedPackageRoot(home);
  if (resolve(source) === resolve(dest) && existsSync(mcpServerPath(dest))) return dest;
  mkdirSync(home, { recursive: true });
  const packDir = mkdtempSync(join(tmpdir(), "ab-pack-"));
  try {
    const packed = npm(["pack", "--pack-destination", packDir], source)
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .at(-1);
    if (!packed) throw new Error("npm pack produced no tarball name");
    const tgz = existsSync(packed) ? packed : join(packDir, packed);
    if (!existsSync(tgz)) throw new Error(`npm pack tarball missing: ${tgz}`);
    npm(["install", "--omit=dev", "--no-fund", "--no-audit", "--prefix", home, tgz]);
  } finally {
    rmSync(packDir, { recursive: true, force: true });
  }
  if (!existsSync(mcpServerPath(dest))) {
    throw new Error(`install completed but MCP server missing: ${mcpServerPath(dest)}`);
  }
  return dest;
}

function writeSkill(root: string): string {
  const src = skillSourcePath(root);
  if (!existsSync(src)) throw new Error(`Skill source missing: ${src}`);
  const dir = join(codexHome(), "skills", "agent-bridge");
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, "SKILL.md");
  copyFileSync(src, dest);
  return dest;
}

function writeMcpConfig(root: string): string {
  const configPath = join(codexHome(), "config.toml");
  mkdirSync(dirname(configPath), { recursive: true });
  const existing = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const snippet = mcpSnippet({
    node: process.execPath,
    server: mcpServerPath(root),
    cwd: root,
    nodePath: nodeModulePath(root),
  });
  writeFileSync(configPath, upsertAgentBridgeMcp(existing, snippet));
  return configPath;
}

function removeMcpConfig(): string {
  const configPath = join(codexHome(), "config.toml");
  if (!existsSync(configPath)) return configPath;
  const next = stripAgentBridgeMcp(readFileSync(configPath, "utf8"));
  writeFileSync(configPath, next.length > 0 ? `${next}\n` : "");
  return configPath;
}

export function runUninstall(opts: SetupOptions = {}): void {
  const configPath = removeMcpConfig();
  console.log(`MCP removed from ${configPath}`);
  const skillDir = join(codexHome(), "skills", "agent-bridge");
  rmSync(skillDir, { recursive: true, force: true });
  console.log(`Skill removed: ${skillDir}`);
  if (opts.purge) {
    const home = bridgeHome();
    rmSync(home, { recursive: true, force: true });
    console.log(`Install home removed: ${home}`);
  } else {
    console.log(`Kept ${bridgeHome()} (pass --purge to delete)`);
  }
}

export function runSetup(opts: SetupOptions = {}): string {
  if (opts.uninstall) {
    runUninstall(opts);
    return packageRoot;
  }

  const source = packageRoot;
  const root = opts.dev ? source : materializeInstall(source);
  const snippet = mcpSnippet({
    node: process.execPath,
    server: mcpServerPath(root),
    cwd: root,
    nodePath: nodeModulePath(root),
  });

  const skillDest = writeSkill(root);
  console.log(`Skill installed: ${skillDest}`);
  console.log(`Runtime: ${root}`);

  if (opts.printOnly || opts.writeMcp === false) {
    console.log("MCP snippet (not written; pass setup without --print-only to write):");
    console.log(snippet);
  } else {
    const configPath = writeMcpConfig(root);
    console.log(`MCP registered in ${configPath}`);
  }

  console.log(
    "Prerequisite: at least one Worker (Claude Code or DeepSeek Harness) must already run independently. Agent Bridge detects this; it does not install or configure Workers.",
  );
  console.log("Reopen Codex after this setup so bridge_* tools load.");

  const report = runDoctor({ repoRoot: root });
  for (const check of report.checks) {
    console.log(`${check.ok ? "ok" : "FAIL"}  ${check.id}: ${check.detail}`);
  }
  for (const agent of report.agents) {
    console.log(`${agent.available ? "ok" : "no "}  worker ${agent.id}: ${agent.detail}`);
  }
  return root;
}

export const installedName = PACKAGE_NAME;

import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_NAME = "codex-agent-bridge";

const KNOWN_NAMES = new Set([PACKAGE_NAME, "agent-relay"]);

export function packageRootFrom(metaUrl: string): string {
  let dir = dirname(fileURLToPath(metaUrl));
  for (let i = 0; i < 8; i += 1) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string };
        if (parsed.name && KNOWN_NAMES.has(parsed.name)) return resolve(dir);
      } catch {
        // keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(dirname(fileURLToPath(metaUrl)), "..");
}

export const packageRoot = packageRootFrom(import.meta.url);

export function codexHome(): string {
  return resolve(process.env.CODEX_HOME ?? join(homedir(), ".codex"));
}

export function bridgeHome(): string {
  if (process.env.AGENT_BRIDGE_HOME) return resolve(process.env.AGENT_BRIDGE_HOME);
  if (process.env.NODE_TEST_CONTEXT) {
    // Shared across the test process and MCP/CLI children so they see the same store.
    return resolve(join(tmpdir(), "agent-bridge-tests"));
  }
  return resolve(join(homedir(), ".agent-bridge"));
}

export function installedPackageRoot(home = bridgeHome()): string {
  return join(home, "node_modules", PACKAGE_NAME);
}

export function mcpServerPath(root: string): string {
  return join(root, "src", "mcp", "server.ts");
}

export function skillSourcePath(root: string): string {
  return join(root, "skills", "agent-bridge", "SKILL.md");
}

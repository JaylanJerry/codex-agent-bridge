import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { claudeAdapterPath, deepSeekHarnessRoot } from "../workers/profiles.ts";
import { hasDeepseekApiKey } from "../workers/credentials.ts";
import { createKillOnCloseJob } from "../process/job-object.ts";
import { isTerminalState, type TaskRecord } from "./state.ts";
import { isProtectedAgentBridgeWorktree, listAgentBridgeWorktrees, worktreeKey } from "../workspace/worktree.ts";
import { inspectCoreLock } from "../persistence/lock.ts";
import { codexHome } from "../paths.ts";

export type DoctorCheck = {
  id: string;
  ok: boolean;
  detail: string;
};

export type AgentInfo = {
  id: string;
  displayName: string;
  available: boolean;
  runtime: "replay" | "acp";
  loadSession: boolean | null;
  detail: string;
};

export type DoctorReport = {
  version: string;
  checks: DoctorCheck[];
  agents: AgentInfo[];
};

function packageVersion(repoRoot: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function gitVersion(): DoctorCheck {
  const proc = spawnSync("git", ["--version"], { encoding: "utf8", windowsHide: true });
  if (proc.status !== 0) {
    return { id: "git", ok: false, detail: (proc.stderr || proc.stdout || "git missing").trim() };
  }
  return { id: "git", ok: true, detail: (proc.stdout || "git").trim() };
}

function probeJobObject(): DoctorCheck {
  if (process.platform !== "win32") {
    return { id: "job-object", ok: true, detail: `skipped on ${process.platform}` };
  }
  try {
    const job = createKillOnCloseJob();
    job.close();
    return { id: "job-object", ok: true, detail: "KILL_ON_JOB_CLOSE create/close succeeded" };
  } catch (error) {
    return {
      id: "job-object",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function claudeCredentialsPresent(): boolean {
  const home = homedir();
  return (
    existsSync(join(home, ".claude.json")) || existsSync(join(home, ".claude", ".credentials.json"))
  );
}

function tsxPresent(repoRoot: string): DoctorCheck {
  try {
    const require = createRequire(join(repoRoot, "package.json"));
    const resolved = require.resolve("tsx/package.json");
    return { id: "tsx", ok: true, detail: resolved };
  } catch {
    const fallback = join(repoRoot, "node_modules", "tsx", "package.json");
    return {
      id: "tsx",
      ok: existsSync(fallback),
      detail: fallback,
    };
  }
}

function mcpRegistered(): DoctorCheck {
  const configPath = join(codexHome(), "config.toml");
  if (!existsSync(configPath)) {
    return { id: "codex-mcp", ok: false, detail: `${configPath} missing` };
  }
  const text = readFileSync(configPath, "utf8");
  const ok = /\[mcp_servers\.agent-bridge\]/.test(text);
  return {
    id: "codex-mcp",
    ok,
    detail: ok ? "config.toml has [mcp_servers.agent-bridge]" : "agent-bridge MCP not registered",
  };
}

function skillInstalled(): DoctorCheck {
  const skillPath = join(codexHome(), "skills", "agent-bridge", "SKILL.md");
  const ok = existsSync(skillPath);
  return {
    id: "codex-skill",
    ok,
    detail: ok ? skillPath : `${skillPath} missing — run: npx -y codex-agent-bridge`,
  };
}

function loadTaskStore(projectPath: string): { tasks: TaskRecord[]; corrupted?: string } {
  const path = join(projectPath, ".agent-bridge-data", "tasks.json");
  if (!existsSync(path)) return { tasks: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { tasks?: TaskRecord[] };
    return { tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [] };
  } catch (error) {
    return { tasks: [], corrupted: error instanceof Error ? error.message : String(error) };
  }
}

export function listOrphanWorktrees(projectPath: string): string[] {
  const store = loadTaskStore(projectPath);
  if (store.corrupted) return [];
  const live = store.tasks.filter((task) => !isTerminalState(task.state) && task.worktreePath);
  const protectedKeys = new Set(live.map((task) => worktreeKey(task.worktreePath!)));
  const protectedTaskIds = new Set(live.flatMap((task) => [task.taskId, task.taskId.toLowerCase()]));
  return listAgentBridgeWorktrees(projectPath).filter(
    (path) => !isProtectedAgentBridgeWorktree(path, protectedKeys, protectedTaskIds),
  );
}

export function listAgents(repoRoot: string): AgentInfo[] {
  const claudePath = claudeAdapterPath(repoRoot);
  const claudeOk = existsSync(claudePath);
  const harness = deepSeekHarnessRoot(repoRoot);
  const deepseekOk = Boolean(harness);
  const deepseekKey = hasDeepseekApiKey();
  return [
    {
      id: "replay",
      displayName: "Replay",
      available: true,
      runtime: "replay",
      loadSession: null,
      detail: "deterministic fixture driver; no LLM",
    },
    {
      id: "claude",
      displayName: "Claude Code",
      available: claudeOk,
      runtime: "acp",
      loadSession: true,
      detail: claudeOk
        ? claudeCredentialsPresent()
          ? "adapter present; credentials file present"
          : "adapter present; Claude credentials file not found"
        : `adapter missing: ${claudePath}`,
    },
    {
      id: "deepseek",
      displayName: "DeepSeek Harness",
      available: deepseekOk && deepseekKey,
      runtime: "acp",
      loadSession: false,
      detail: !deepseekOk
        ? "harness not found (set AGENT_BRIDGE_DEEPSEEK_ROOT; Bridge does not install DeepSeek Harness)"
        : deepseekKey
          ? `harness present at ${harness}; API key present`
          : `harness present at ${harness}; DEEPSEEK_API_KEY missing`,
    },
  ];
}

export function runDoctor(opts: { repoRoot: string; projectPath?: string }): DoctorReport {
  const checks: DoctorCheck[] = [
    { id: "node", ok: true, detail: process.version },
    gitVersion(),
    tsxPresent(opts.repoRoot),
    probeJobObject(),
    mcpRegistered(),
    skillInstalled(),
  ];
  const agents = listAgents(opts.repoRoot);
  const readyWorkers = agents.filter(
    (agent) =>
      (agent.id === "claude" && agent.available && !agent.detail.includes("credentials file not found")) ||
      (agent.id === "deepseek" && agent.available),
  );
  checks.push({
    id: "worker-ready",
    ok: readyWorkers.length > 0,
    detail:
      readyWorkers.length > 0
        ? readyWorkers.map((agent) => agent.id).join(", ")
        : "no independently configured Worker (Claude credentials or DeepSeek API key). Bridge detects; it does not configure models or third-party providers",
  });
  if (opts.projectPath) {
    const gitDir = existsSync(join(opts.projectPath, ".git"));
    checks.push({
      id: "project-git",
      ok: gitDir,
      detail: gitDir ? opts.projectPath : `${opts.projectPath} is not a git repo`,
    });
    const verify = existsSync(join(opts.projectPath, ".agent-bridge", "verify.json"));
    checks.push({
      id: "verify-json",
      ok: true,
      detail: verify
        ? ".agent-bridge/verify.json present"
        : ".agent-bridge/verify.json missing (verification will skip)",
    });
    if (gitDir) {
      const dataDir = join(opts.projectPath, ".agent-bridge-data");
      if (existsSync(dataDir)) {
        const lock = inspectCoreLock(dataDir);
        checks.push({
          id: "core-lock",
          ok: lock.state !== "unreadable",
          detail: lock.detail,
        });
        const store = loadTaskStore(opts.projectPath);
        checks.push({
          id: "tasks-json",
          ok: !store.corrupted,
          detail: store.corrupted
            ? `TASK_STORE_CORRUPTED: ${store.corrupted}`
            : `${store.tasks.length} task(s)`,
        });
      }
      const orphans = listOrphanWorktrees(opts.projectPath);
      checks.push({
        id: "orphan-worktrees",
        ok: orphans.length === 0,
        detail: orphans.length === 0 ? "none" : orphans.join("; "),
      });
    }
  }
  return {
    version: packageVersion(opts.repoRoot),
    checks,
    agents,
  };
}

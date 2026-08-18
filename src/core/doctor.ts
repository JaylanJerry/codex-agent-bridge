import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { claudeAdapterPath, deepSeekHarnessRoot } from "../workers/profiles.ts";
import { hasDeepseekApiKey } from "../workers/credentials.ts";
import { createKillOnCloseJob } from "../process/job-object.ts";
import { isTerminalState, type TaskRecord } from "./state.ts";
import { listAgentBridgeWorktrees, worktreeKey } from "../workspace/worktree.ts";

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

function mcpRegistered(): DoctorCheck {
  const configPath = join(homedir(), ".codex", "config.toml");
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

function loadTasks(projectPath: string): TaskRecord[] {
  const path = join(projectPath, ".agent-bridge-data", "tasks.json");
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { tasks?: TaskRecord[] };
    return parsed.tasks ?? [];
  } catch {
    return [];
  }
}

export function listOrphanWorktrees(projectPath: string): string[] {
  const protectedKeys = new Set(
    loadTasks(projectPath)
      .filter((task) => !isTerminalState(task.state) && task.worktreePath)
      .map((task) => worktreeKey(task.worktreePath!)),
  );
  return listAgentBridgeWorktrees(projectPath).filter((path) => !protectedKeys.has(worktreeKey(path)));
}

export function listAgents(repoRoot: string): AgentInfo[] {
  const claudePath = claudeAdapterPath(repoRoot);
  const claudeOk = existsSync(claudePath);
  const harness = deepSeekHarnessRoot(repoRoot);
  const deepseekOk =
    existsSync(join(harness, "packages/examples/acp-demo/src/bin.ts")) &&
    existsSync(join(harness, "examples/acp-agent/cordis.yml"));
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
        ? `harness missing under ${harness}`
        : deepseekKey
          ? "harness present; API key present"
          : "harness present; DEEPSEEK_API_KEY missing",
    },
  ];
}

export function runDoctor(opts: { repoRoot: string; projectPath?: string }): DoctorReport {
  const checks: DoctorCheck[] = [
    { id: "node", ok: true, detail: process.version },
    gitVersion(),
    {
      id: "tsx",
      ok: existsSync(join(opts.repoRoot, "node_modules", "tsx", "package.json")),
      detail: join(opts.repoRoot, "node_modules", "tsx"),
    },
    probeJobObject(),
    mcpRegistered(),
  ];
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
    agents: listAgents(opts.repoRoot),
  };
}

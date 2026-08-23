import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { claudeAdapterPath, inspectDeepSeekIntegration } from "../workers/profiles.ts";
import { createKillOnCloseJob } from "../process/job-object.ts";
import { isTerminalState, type TaskRecord } from "./state.ts";
import { isProtectedAgentBridgeWorktree, listAgentBridgeWorktrees, worktreeKey } from "../workspace/worktree.ts";
import { inspectCoreLock } from "../persistence/lock.ts";
import { existingRepoDataDir, existingTasksPath } from "../persistence/layout.ts";
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
      detail: error instanceof Error && error.message ? error.message : "Job Object probe failed",
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
  const path = existingTasksPath(projectPath);
  if (!path) return { tasks: [] };
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
  const deepseek = inspectDeepSeekIntegration(repoRoot);
  const deepseekOk = deepseek.integration !== "missing";
  const deepseekKey = deepseek.credentials === "present";
  const homeBit = deepseek.homePresent ? `DSH_HOME present (${deepseek.home})` : "DSH_HOME missing";
  const officialBit = "official runtime unavailable";
  const deepseekDetail =
    deepseek.integration === "official"
      ? `transport=acp; integration=official; credentials=${deepseek.credentials}; ${homeBit}`
      : deepseek.integration === "legacy"
        ? `transport=acp; integration=legacy; DeepSeek ACP available (legacy source integration); ${officialBit}; path=${deepseek.runtimePath}; credentials=${deepseek.credentials}; ${homeBit}`
        : `transport=acp; integration=missing; ${officialBit}; set AGENT_BRIDGE_DEEPSEEK_ROOT; Bridge does not install DeepSeek Harness; credentials=${deepseek.credentials}; ${homeBit}`;
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
      detail: deepseekDetail,
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
      const dataDir = existingRepoDataDir(opts.projectPath);
      if (dataDir) {
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

function mark(ok: boolean): string {
  return ok ? "✓" : "✗";
}

function hintForCheck(check: DoctorCheck): string | undefined {
  if (check.ok) return undefined;
  switch (check.id) {
    case "git":
      return "Install Git and make sure `git` is on PATH.";
    case "tsx":
      return "Run `npx -y codex-agent-bridge` or `npm install` so tsx is available.";
    case "job-object":
      return "Windows Job Object failed. Reinstall Node 22+ and retry doctor.";
    case "codex-mcp":
      return "Run `npx -y codex-agent-bridge`, then start a new Codex session.";
    case "codex-skill":
      return "Run `npx -y codex-agent-bridge` to install the Codex Skill.";
    case "worker-ready":
      return "Install and sign in to Claude Code, or install DeepSeek Harness and set DEEPSEEK_API_KEY. Bridge does not configure models.";
    case "project-git":
      return "Pass a git repository as `--project`. Run `git init` if this folder is not a repo.";
    case "core-lock":
      return "Another Writer may still hold the project lock. Close the other Bridge process, or wait if the holder pid is still alive.";
    case "tasks-json":
      return "tasks.json is corrupted. Do not treat it as empty. Restore from backup or inspect the file.";
    case "orphan-worktrees":
      return "Run `bridge_prune` / `codex-agent-bridge prune --project <repo>` after confirming no in-flight task owns those worktrees.";
    default:
      return "See the check detail above.";
  }
}

function hintForAgent(agent: AgentInfo): string | undefined {
  if (agent.available && (agent.id !== "claude" || !agent.detail.includes("credentials file not found"))) {
    return undefined;
  }
  if (agent.id === "claude") {
    if (agent.detail.includes("adapter missing")) {
      return "Run `npx -y codex-agent-bridge` so the Claude ACP adapter is installed.";
    }
    return "Sign in to Claude Code once on this machine. Bridge does not store Anthropic keys.";
  }
  if (agent.id === "deepseek") {
    if (agent.detail.includes("integration=missing")) {
      return "Install DeepSeek Harness source, or set AGENT_BRIDGE_DEEPSEEK_ROOT. This is a legacy source ACP path.";
    }
    if (agent.detail.includes("credentials=missing")) {
      return "Set DEEPSEEK_API_KEY or put it in ~/.dsh/.credentials.yaml. Bridge does not print the key.";
    }
  }
  return undefined;
}

export function formatDoctorReport(report: DoctorReport): string {
  const git = report.checks.find((check) => check.id === "git");
  const tsx = report.checks.find((check) => check.id === "tsx");
  const claude = report.agents.find((agent) => agent.id === "claude");
  const deepseek = report.agents.find((agent) => agent.id === "deepseek");
  const project = report.checks.find((check) => check.id === "project-git");
  const claudeReady = Boolean(
    claude?.available && !claude.detail.includes("credentials file not found"),
  );
  const deepseekLegacy = deepseek?.detail.includes("integration=legacy") ?? false;
  const lines = [
    `Agent Bridge doctor v${report.version}`,
    "",
    `${mark(Boolean(tsx?.ok))} Agent Bridge installed`,
    `${mark(Boolean(git?.ok))} Git available`,
    `${mark(claudeReady)} Claude ACP available`,
    `${mark(deepseekLegacy)} DeepSeek ACP legacy available`,
  ];
  if (project) {
    lines.push(`${mark(project.ok)} Workspace ready`);
  } else {
    lines.push("· Workspace not checked (pass --project <git-repo>)");
  }
  lines.push("");

  const problems: string[] = [];
  for (const check of report.checks) {
    if (check.ok) continue;
    const hint = hintForCheck(check);
    problems.push(`Missing: ${check.id}`);
    problems.push(`Why: ${check.detail || "unknown"}`);
    if (hint) problems.push(`Fix: ${hint}`);
    problems.push("");
  }
  for (const agent of report.agents) {
    if (agent.id === "replay") continue;
    const hint = hintForAgent(agent);
    if (!hint) continue;
    problems.push(`Missing: worker ${agent.id}`);
    problems.push(`Why: ${agent.detail || "unknown"}`);
    problems.push(`Fix: ${hint}`);
    problems.push("");
  }
  if (problems.length === 0) {
    lines.push("All required checks passed. Reopen Codex if you just installed MCP.");
  } else {
    lines.push("What to fix:");
    lines.push(...problems);
  }
  lines.push("Checks:");
  for (const check of report.checks) {
    lines.push(`${check.ok ? "ok  " : "FAIL"} ${check.id}: ${check.detail || "unknown"}`);
  }
  lines.push("Workers:");
  for (const agent of report.agents) {
    lines.push(`${agent.available ? "ok  " : "no  "} ${agent.id}: ${agent.detail || "unknown"}`);
  }
  const text = lines.join("\n");
  if (/Error:\s*undefined/i.test(text)) {
    return text.replace(/Error:\s*undefined/gi, "unknown error");
  }
  return text;
}

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { dispatch } from "../src/api/client.ts";
import { readDeepSeekUserSelection } from "../src/workers/launch-policy.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function git(cwd: string, args: string[]) {
  const proc = spawnSync("git", ["-c", "core.longpaths=true", ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  if (proc.status !== 0) throw new Error(proc.stderr || proc.stdout);
  return proc.stdout.trim();
}

function expectedClaudeModel(): string | undefined {
  const path = join(homedir(), ".claude", "settings.json");
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { env?: Record<string, string> };
  return parsed.env?.ANTHROPIC_MODEL?.trim() || parsed.env?.ANTHROPIC_DEFAULT_OPUS_MODEL?.trim();
}

function expectedDeepSeek(): { model?: string; effort?: string; provider?: string } {
  const selection = readDeepSeekUserSelection();
  return { provider: selection.provider, model: selection.model, effort: selection.reasoningEffort };
}

function initRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "ab-inherit-"));
  writeFileSync(join(root, "README.md"), "inheritance probe\n");
  git(root, ["init"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["config", "user.email", "t@t"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "init"]);
  return root;
}

function observedModel(worktreePath: string | undefined): string {
  if (!worktreePath) return "";
  const path = join(worktreePath, "worker-model.txt");
  return existsSync(path) ? readFileSync(path, "utf8").trim() : "";
}

function matches(observed: string, expected: string | undefined): boolean {
  if (!expected) return observed.length > 0;
  const needle = expected.toLowerCase();
  return observed.toLowerCase().includes(needle);
}

async function probe(worker: "claude" | "deepseek", expected: string | undefined) {
  const project = initRepo();
  try {
    const run = await dispatch({
      command: "run",
      project,
      worker,
      permissionMode: "auto",
      timeoutMs: 300_000,
      clientRequestId: `inherit-${worker}-${Date.now()}`,
      objective:
        "Create worker-model.txt with one line: the model identifier you are currently using. Do not commit. Do not modify any other file.",
    });
    const text = observedModel(run.task?.worktreePath);
    const result = {
      worker,
      ok: Boolean(run.ok && run.task?.state === "AWAITING_REVIEW" && matches(text, expected)),
      state: run.task?.state,
      error: run.error,
      expected,
      observed: text.slice(0, 200),
      changedFiles: run.reviewPacket?.changedFiles,
    };
    if (run.task?.taskId && run.task.stateVersion !== undefined) {
      await dispatch({
        command: "reject",
        project,
        task: run.task.taskId,
        stateVersion: run.task.stateVersion,
      }).catch(() => undefined);
    }
    return result;
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

process.env.AGENT_BRIDGE_HOME = mkdtempSync(join(tmpdir(), "ab-inherit-home-"));

const claudeExpected = expectedClaudeModel();
const deepseekExpected = expectedDeepSeek();
const report = {
  claude: await probe("claude", claudeExpected),
  deepseek: await probe("deepseek", deepseekExpected.model),
  deepseekExpected,
};
console.log(JSON.stringify(report, null, 2));
try {
  rmSync(process.env.AGENT_BRIDGE_HOME, { recursive: true, force: true });
} catch {
  // Windows may keep a worker handle on the isolated home for a moment.
}
process.exit(report.claude.ok && report.deepseek.ok ? 0 : 1);

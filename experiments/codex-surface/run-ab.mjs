import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const artifactDir = resolve(repoRoot, "phase0/artifacts");
const cli = resolve(here, "cli.mjs");
const mcp = resolve(here, "mcp-server.mjs");
const codexJs = resolve(
  process.env.APPDATA,
  "npm/node_modules/@openai/codex/bin/codex.js",
);

mkdirSync(artifactDir, { recursive: true });

function runNode(args, env = {}) {
  const started = Date.now();
  const proc = spawnSync(process.execPath, args, {
    cwd: here,
    encoding: "utf8",
    env: { ...process.env, ...env },
    windowsHide: true,
  });
  return {
    command: [process.execPath, ...args].join(" "),
    status: proc.status,
    elapsedMs: Date.now() - started,
    stdout: (proc.stdout ?? "").trim(),
    stderr: (proc.stderr ?? "").trim(),
  };
}

function parseJsonLine(text) {
  const line = text.trim().split(/\r?\n/).at(-1);
  try {
    return JSON.parse(line);
  } catch {
    return { unparsed: text };
  }
}

const localStart = runNode([cli, "start"]);
const localWait = runNode([cli, "wait"], { BRIDGE_PROBE_WAIT_MS: "3000" });

function runCodex(args, label) {
  return new Promise((resolveRun) => {
    const started = Date.now();
    const child = spawn(process.execPath, [codexJs, ...args], {
      cwd: here,
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, 180_000);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolveRun({
        label,
        command: ["codex", ...args].join(" "),
        status: code,
        signal,
        elapsedMs: Date.now() - started,
        stdout,
        stderr,
      });
    });
  });
}

const common = [
  "exec",
  "--json",
  "--skip-git-repo-check",
  "--approve-for-me",
  "-C",
  here,
];

const cliPrompt =
  "Run `node cli.mjs start` then `node cli.mjs wait`. Return only the final JSON object from wait. Do not edit files.";

const mcpPrompt =
  "Call the MCP tool probe_start, then probe_wait. Return only the structured JSON from probe_wait. Do not edit files.";

const mcpConfig = `mcp_servers.bridge_probe.command="${process.execPath.replaceAll("\\", "/")}"`;
const mcpArgs = `mcp_servers.bridge_probe.args=["${mcp.replaceAll("\\", "/")}"]`;

const [codexCli, codexMcp] = [
  await runCodex([...common, cliPrompt], "codex-cli"),
  await runCodex(
    [...common, "-c", mcpConfig, "-c", mcpArgs, mcpPrompt],
    "codex-mcp",
  ),
];

function countApprovals(stdout) {
  const matches = stdout.match(/approv|permission|exec_approval|patch_approval/gi) ?? [];
  return matches.length;
}

function summarizeExec(run) {
  const events = [];
  for (const line of run.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // ignore
    }
  }
  const types = {};
  for (const event of events) {
    const type = event.type ?? "unknown";
    types[type] = (types[type] ?? 0) + 1;
  }
  const errors = events
    .filter((event) => event.type === "error" || event.item?.type === "error")
    .map((event) => event.message ?? event.item?.message ?? event.error?.message);
  const toolNames = events
    .filter((event) => event.type === "item.started" || event.type === "item.completed")
    .map((event) => event.item?.command ?? event.item?.tool ?? event.item?.type)
    .filter(Boolean);
  return {
    status: run.status,
    signal: run.signal,
    elapsedMs: run.elapsedMs,
    eventTypes: types,
    errors,
    toolNames,
    approvalHits: countApprovals(run.stdout + run.stderr),
    stdoutTail: run.stdout.slice(-4000),
    stderrTail: run.stderr.slice(-2000),
  };
}

const summary = {
  startedAt: new Date().toISOString(),
  localCli: {
    start: { ...localStart, json: parseJsonLine(localStart.stdout) },
    wait: { ...localWait, json: parseJsonLine(localWait.stdout) },
  },
  comparison: {
    structuredParams: {
      cli: "argv only",
      mcp: "JSON tool arguments",
    },
    structuredResult: {
      cli: Boolean(parseJsonLine(localWait.stdout).ok),
      mcp: "via structuredContent on tools/call",
    },
    longWaitLocalMs: localWait.elapsedMs,
  },
  codexCli: summarizeExec(codexCli),
  codexMcp: summarizeExec(codexMcp),
};

writeFileSync(resolve(artifactDir, "codex-surface-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
writeFileSync(resolve(artifactDir, "codex-cli.exec.jsonl"), `${codexCli.stdout}\n`);
writeFileSync(resolve(artifactDir, "codex-mcp.exec.jsonl"), `${codexMcp.stdout}\n`);
process.stdout.write(`${JSON.stringify({ ok: localWait.status === 0, localWaitMs: localWait.elapsedMs, codexCli: codexCli.status, codexMcp: codexMcp.status }, null, 2)}\n`);
process.exitCode = localWait.status === 0 ? 0 : 1;

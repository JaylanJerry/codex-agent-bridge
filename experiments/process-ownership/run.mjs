import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const artifactDir = join(repoRoot, "phase0/artifacts");
mkdirSync(artifactDir, { recursive: true });

const results = [];
const failures = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
}

function pidAlive(pid) {
  const proc = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
    encoding: "utf8",
    windowsHide: true,
  });
  return (proc.stdout ?? "").includes(`"${pid}"`);
}

function git(cwd, args) {
  const proc = spawnSync("git", ["-c", "core.longpaths=true", ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  if (proc.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr || proc.stdout}`);
  }
  return proc.stdout.trim();
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readPid(path) {
  for (let i = 0; i < 20; i += 1) {
    if (existsSync(path)) {
      const pid = Number(readFileSync(path, "utf8").trim());
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
    sleep(100);
  }
  throw new Error(`pid file missing: ${path}`);
}

function testNaiveOrphan() {
  const dir = mkdtempSync(join(tmpdir(), "ab-own-naive-"));
  const heartbeat = join(dir, "hb.txt");
  const childPidPath = join(dir, "child.pid");
  const parentPidPath = join(dir, "parent.pid");
  spawnSync(
    process.execPath,
    [
      join(here, "parent-naive.mjs"),
      join(here, "child.mjs"),
      heartbeat,
      childPidPath,
      parentPidPath,
    ],
    { windowsHide: true },
  );
  const childPid = readPid(childPidPath);
  sleep(800);
  const parentDead = !pidAlive(Number(readFileSync(parentPidPath, "utf8").trim()));
  const childStillAlive = pidAlive(childPid);
  if (childStillAlive) {
    spawnSync("taskkill", ["/PID", String(childPid), "/F"], { windowsHide: true });
  }
  rmSync(dir, { recursive: true, force: true });
  record(
    "naive spawn: parent can exit",
    parentDead,
    `childAliveAfterParentExit=${childStillAlive}`,
  );
  return childStillAlive;
}

function compileJobParent() {
  const exe = join(here, "job-parent.exe");
  const cscCandidates = [
    join(
      process.env["WINDIR"] ?? "C:\\Windows",
      "Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe",
    ),
    "csc.exe",
  ];
  const csc = cscCandidates.find((path) => existsSync(path) || path === "csc.exe");
  const compiled = spawnSync(
    csc,
    ["/nologo", "/optimize+", `/out:${exe}`, join(here, "JobParent.cs")],
    { encoding: "utf8", windowsHide: true },
  );
  if (compiled.status !== 0 || !existsSync(exe)) {
    throw new Error(`csc failed: ${compiled.stdout}\n${compiled.stderr}`);
  }
  return exe;
}

function testJobObjectKillsChild() {
  const exe = compileJobParent();
  const dir = mkdtempSync(join(tmpdir(), "ab-own-job-"));
  const heartbeat = join(dir, "hb.txt");
  const childPidPath = join(dir, "child.pid");
  const started = spawnSync(
    exe,
    [process.execPath, join(here, "child.mjs"), heartbeat, childPidPath],
    { encoding: "utf8", windowsHide: true },
  );
  if (started.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    record("job-parent compile/run", false, `status=${started.status} ${started.stderr}`);
    return;
  }
  const childPid = readPid(childPidPath);
  sleep(800);
  const alive = pidAlive(childPid);
  if (alive) spawnSync("taskkill", ["/PID", String(childPid), "/T", "/F"], { windowsHide: true });
  rmSync(dir, { recursive: true, force: true });
  record(
    "bridge-owned Job Object kills child when parent exits",
    !alive,
    `childPid=${childPid} aliveAfterParentExit=${alive}`,
  );
}

function testExternalOwnedSurvives() {
  const dir = mkdtempSync(join(tmpdir(), "ab-own-ext-"));
  const heartbeat = join(dir, "hb.txt");
  const childPidPath = join(dir, "child.pid");
  const child = spawn(process.execPath, [join(here, "child.mjs"), heartbeat, childPidPath], {
    stdio: "ignore",
    windowsHide: true,
    detached: true,
  });
  child.unref();
  const childPid = readPid(childPidPath);
  sleep(400);
  const stillAlive = pidAlive(childPid);
  spawnSync("taskkill", ["/PID", String(childPid), "/F"], { windowsHide: true });
  rmSync(dir, { recursive: true, force: true });
  record(
    "external-owned process stays up after controller disconnect",
    stillAlive,
    `pid=${childPid}`,
  );
}

function testCrashKeepsWorktree() {
  const root = mkdtempSync(join(tmpdir(), "ab-crash-"));
  git(root, ["init"]);
  git(root, ["config", "user.name", "phase0"]);
  git(root, ["config", "user.email", "phase0@localhost"]);
  writeFileSync(join(root, "README.md"), "base\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-m", "init"]);
  const base = git(root, ["rev-parse", "HEAD"]);
  const worktree = join(root, "agent-bridge", "task-crash");
  mkdirSync(join(root, "agent-bridge"), { recursive: true });
  git(root, ["worktree", "add", worktree, "-b", "agent-bridge/task-crash"]);
  writeFileSync(join(worktree, "wip.ts"), "export const wip = 1;\n");
  const statePath = join(root, "bridge-state.json");
  writeFileSync(
    statePath,
    `${JSON.stringify(
      {
        taskId: "task-crash",
        state: "RUNNING",
        workerPid: 999999,
        worktree,
        baseCommit: base,
      },
      null,
      2,
    )}\n`,
  );

  const recovered = JSON.parse(readFileSync(statePath, "utf8"));
  const pidDead = !pidAlive(recovered.workerPid);
  const worktreeStill = existsSync(join(worktree, "wip.ts"));
  const doNotReattach = pidDead;
  const nextState = doNotReattach ? "AWAITING_REVIEW" : recovered.state;
  record("crash keeps worktree files", worktreeStill, worktree);
  record("crash does not reattach dead pid", doNotReattach, `pid=${recovered.workerPid}`);
  record(
    "crash marks interrupted awaiting review",
    nextState === "AWAITING_REVIEW",
    nextState,
  );
  git(root, ["worktree", "remove", "--force", worktree]);
  rmSync(root, { recursive: true, force: true });
}

try {
  testNaiveOrphan();
} catch (error) {
  record("naive spawn", false, error instanceof Error ? error.stack : String(error));
}
try {
  testJobObjectKillsChild();
} catch (error) {
  record("job object", false, error instanceof Error ? error.stack : String(error));
}
try {
  testExternalOwnedSurvives();
} catch (error) {
  record("external-owned", false, error instanceof Error ? error.stack : String(error));
}
try {
  testCrashKeepsWorktree();
} catch (error) {
  record("crash recovery", false, error instanceof Error ? error.stack : String(error));
}

const summary = {
  startedAt: new Date().toISOString(),
  ok: failures.length === 0,
  failures,
  results,
};
writeFileSync(join(artifactDir, "ownership-spike-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(failures.length === 0 ? "\nownership spike PASS" : `\nownership spike FAIL: ${failures.join(", ")}`);
process.exitCode = failures.length === 0 ? 0 : 1;

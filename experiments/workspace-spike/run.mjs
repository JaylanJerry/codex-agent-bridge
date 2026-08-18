import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const artifactDir = join(here, "../../phase0/artifacts");
mkdirSync(artifactDir, { recursive: true });

const failures = [];
const results = [];

function git(cwd, args, allowFail = false) {
  const proc = spawnSync("git", ["-c", "core.longpaths=true", ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  if (!allowFail && proc.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}:\n${proc.stderr || proc.stdout}`);
  }
  return {
    status: proc.status,
    stdout: proc.stdout ?? "",
    stderr: proc.stderr ?? "",
  };
}

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const mark = ok ? "PASS" : "FAIL";
  console.log(`${mark}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
}

function collectChanges(cwd, baseCommit) {
  const head = git(cwd, ["rev-parse", "HEAD"]).stdout.trim();
  const ranged = git(cwd, ["diff", "--name-only", `${baseCommit}..HEAD`]).stdout.trim();
  const porcelain = git(cwd, ["status", "--porcelain=v1", "-uall"]).stdout;
  const trackedDiff = git(cwd, ["diff", "--name-status", baseCommit, "--"]).stdout;
  const files = new Map();

  for (const line of porcelain.split(/\r?\n/)) {
    if (!line) continue;
    const code = line.slice(0, 2);
    const rest = line.slice(3);
    if (code === "R " || code.startsWith("R") || line[0] === "R") {
      const [oldPath, newPath] = rest.split(" -> ");
      files.set(newPath ?? rest, {
        change: "renamed",
        oldPath,
        tracked: true,
      });
      continue;
    }
    if (code.includes("D") || line.startsWith(" D") || line.startsWith("D ")) {
      files.set(rest, { change: "deleted", tracked: true });
      continue;
    }
    if (code === "??") {
      files.set(rest, { change: "added", tracked: false });
      continue;
    }
    if (code.includes("A") || line.startsWith("A ")) {
      files.set(rest, { change: "added", tracked: true });
      continue;
    }
    files.set(rest, { change: "modified", tracked: true });
  }

  return {
    head,
    headEqualsBase: head === baseCommit,
    rangedDiffEmpty: ranged.length === 0,
    porcelain,
    trackedDiff,
    files: [...files.entries()].map(([path, info]) => ({ path, ...info })),
  };
}

function testWorktree() {
  const root = mkdtempSync(join(tmpdir(), "ab-wt-"));
  git(root, ["init"]);
  git(root, ["config", "user.name", "phase0"]);
  git(root, ["config", "user.email", "phase0@localhost"]);
  writeFileSync(join(root, "README.md"), "base\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-m", "init"]);
  const base = git(root, ["rev-parse", "HEAD"]).stdout.trim();

  const ascii = join(root, "wt-ascii");
  const chinese = join(root, "任务-工作区");
  const spaced = join(root, "path with spaces");

  try {
    git(root, ["worktree", "add", ascii, "-b", "task-ascii"]);
    git(root, ["worktree", "add", chinese, "-b", "task-zh"]);
    git(root, ["worktree", "add", spaced, "-b", "task-space"]);
    record("worktree ascii", existsSync(join(ascii, "README.md")), ascii);
    record("worktree chinese path", existsSync(join(chinese, "README.md")), chinese);
    record("worktree space path", existsSync(join(spaced, "README.md")), spaced);

    const envSrc = join(root, ".env");
    writeFileSync(envSrc, "SECRET=phase0\n");
    copyFileSync(envSrc, join(ascii, ".env"));
    record("worktree copy .env", existsSync(join(ascii, ".env")));

    const nmSrc = join(root, "node_modules_src");
    mkdirSync(nmSrc);
    writeFileSync(join(nmSrc, "pkg.json"), "{}\n");
    const nmDest = join(ascii, "node_modules");
    const link = spawnSync("cmd.exe", ["/c", "mklink", "/J", nmDest, nmSrc], {
      encoding: "utf8",
      windowsHide: true,
    });
    record(
      "worktree node_modules junction",
      existsSync(join(nmDest, "pkg.json")),
      (link.stdout + link.stderr).trim(),
    );

    git(root, ["worktree", "remove", "--force", ascii], true);
    git(root, ["worktree", "remove", "--force", chinese], true);
    git(root, ["worktree", "remove", "--force", spaced], true);
    const remaining = git(root, ["worktree", "list", "--porcelain"]).stdout;
    record(
      "worktree cleanup",
      !remaining.includes("task-ascii") && !remaining.includes("task-zh"),
      remaining.trim().split(/\r?\n/)[0],
    );
    record("worktree base HEAD unchanged", git(root, ["rev-parse", "HEAD"]).stdout.trim() === base);
  } finally {
    git(root, ["worktree", "prune"], true);
    rmSync(root, { recursive: true, force: true });
  }
}

function testChangeCollectorAndCheckpoint() {
  const root = mkdtempSync(join(tmpdir(), "ab-cc-"));
  git(root, ["init"]);
  git(root, ["config", "user.name", "phase0"]);
  git(root, ["config", "user.email", "phase0@localhost"]);
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "c.ts"), "export const c = 1;\n");
  writeFileSync(join(root, "d.ts"), "export const d = 1;\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "base A"]);
  const base = git(root, ["rev-parse", "HEAD"]).stdout.trim();

  writeFileSync(join(root, "a.ts"), "export const a = 2;\n");
  writeFileSync(join(root, "b.ts"), "export const b = 1;\n");
  git(root, ["rm", "c.ts"]);
  git(root, ["mv", "d.ts", "e.ts"]);

  const collected = collectChanges(root, base);
  const kinds = new Set(collected.files.map((file) => `${file.change}:${file.path.replaceAll("\\", "/")}`));

  record("collector HEAD still base", collected.headEqualsBase, collected.head);
  record("collector git diff base..HEAD empty", collected.rangedDiffEmpty, "must not use ranged commit diff");
  record("collector sees modified a.ts", [...kinds].some((k) => k.includes("modified:a.ts")));
  record("collector sees added b.ts", [...kinds].some((k) => k.includes("added:b.ts")));
  record("collector sees deleted c.ts", [...kinds].some((k) => k.includes("deleted:c.ts")));
  record("collector sees renamed e.ts", [...kinds].some((k) => k.includes("renamed:e.ts")));

  const beforeHash = git(root, ["hash-object", "a.ts"]).stdout.trim();
  git(root, ["checkout", "-b", "agent-bridge/task-1"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "checkpoint: phase0 task-1"]);
  const approved = git(root, ["rev-parse", "HEAD"]).stdout.trim();
  record("checkpoint commit created", Boolean(approved), approved);

  const integrate = mkdtempSync(join(tmpdir(), "ab-int-"));
  git(root, ["clone", "--bare", root, join(integrate, "src.git")]);
  git(integrate, ["clone", join(integrate, "src.git"), "work"]);
  const work = join(integrate, "work");
  git(work, ["config", "user.name", "phase0"]);
  git(work, ["config", "user.email", "phase0@localhost"]);
  git(work, ["checkout", base]);
  const pick = git(work, ["cherry-pick", approved], true);
  record(
    "cherry-pick approved checkpoint",
    pick.status === 0 && existsSync(join(work, "b.ts")) && !existsSync(join(work, "c.ts")),
    pick.stderr.trim() || pick.stdout.trim().split(/\r?\n/).at(-1),
  );

  writeFileSync(join(root, "a.ts"), "export const a = 999;\n");
  const afterHash = git(root, ["hash-object", "a.ts"]).stdout.trim();
  record(
    "reject approve after review drift",
    beforeHash !== afterHash,
    `before=${beforeHash} after=${afterHash}`,
  );

  rmSync(root, { recursive: true, force: true });
  rmSync(integrate, { recursive: true, force: true });
}

try {
  testWorktree();
  testChangeCollectorAndCheckpoint();
} catch (error) {
  record("spike crashed", false, error instanceof Error ? error.stack : String(error));
}

const summary = {
  startedAt: new Date().toISOString(),
  ok: failures.length === 0,
  failures,
  results,
};
writeFileSync(join(artifactDir, "workspace-spike-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(failures.length === 0 ? "\nworkspace spike PASS" : `\nworkspace spike FAIL: ${failures.join(", ")}`);
process.exitCode = failures.length === 0 ? 0 : 1;

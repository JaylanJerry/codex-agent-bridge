import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { collectChanges, parsePorcelainLine } from "../src/workspace/changes.ts";

function git(cwd: string, args: string[]) {
  const proc = spawnSync("git", ["-c", "core.longpaths=true", ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  if (proc.status !== 0) throw new Error(proc.stderr || proc.stdout);
  return proc.stdout.trim();
}

test("ChangeCollector sees working-tree edits while HEAD stays at base", () => {
  const root = mkdtempSync(join(tmpdir(), "ab-chg-"));
  git(root, ["init"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["config", "user.email", "t@t"]);
  writeFileSync(join(root, "a.ts"), "a1\n");
  writeFileSync(join(root, "c.ts"), "c1\n");
  writeFileSync(join(root, "d.ts"), "d1\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "A"]);
  const base = git(root, ["rev-parse", "HEAD"]);
  writeFileSync(join(root, "a.ts"), "a2\n");
  writeFileSync(join(root, "b.ts"), "b1\n");
  git(root, ["rm", "c.ts"]);
  git(root, ["mv", "d.ts", "e.ts"]);
  const set = collectChanges(root, base);
  assert.equal(set.headEqualsBase, true);
  assert.equal(set.rangedDiffEmpty, true);
  const kinds = new Set(set.files.map((file) => `${file.change}:${file.path.replaceAll("\\", "/")}`));
  assert.deepEqual(
    [...kinds].sort(),
    ["added:b.ts", "deleted:c.ts", "modified:a.ts", "renamed:e.ts"].sort(),
  );
  rmSync(root, { recursive: true, force: true });
});

test("porcelain parser keeps leading-space unstaged modify", () => {
  assert.deepEqual(parsePorcelainLine(" M a.ts"), {
    path: "a.ts",
    change: "modified",
    tracked: true,
  });
  assert.deepEqual(parsePorcelainLine("R  d.ts -> e.ts"), {
    path: "e.ts",
    change: "renamed",
    oldPath: "d.ts",
    tracked: true,
  });
});

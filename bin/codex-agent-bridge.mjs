#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(pkgRoot, "src", "cli.ts");
const tsx = import.meta.resolve("tsx");
const userArgs = process.argv.slice(2);
const args = userArgs.length === 0 ? ["setup"] : userArgs;
const result = spawnSync(process.execPath, ["--import", tsx, cli, ...args], {
  stdio: "inherit",
  windowsHide: true,
});
process.exit(result.status ?? 1);

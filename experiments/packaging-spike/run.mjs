import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const artifactDir = join(repoRoot, "phase0/artifacts");
const sdkRoot = resolve(repoRoot, "experiments/acp-deepseek");
mkdirSync(artifactDir, { recursive: true });

const require = createRequire(join(sdkRoot, "package.json"));
let sdkPath = "";
try {
  sdkPath = require.resolve("@agentclientprotocol/sdk");
} catch (error) {
  sdkPath = String(error);
}

const importProbe = spawnSync(
  process.execPath,
  [
    "--input-type=module",
    "-e",
    "import * as acp from '@agentclientprotocol/sdk'; console.log(JSON.stringify({ protocolVersion: acp.PROTOCOL_VERSION, hasClient: typeof acp.ClientSideConnection === 'function' }))",
  ],
  { cwd: sdkRoot, encoding: "utf8", windowsHide: true },
);

const bun = spawnSync("bun", ["--version"], { encoding: "utf8", windowsHide: true });
const summary = {
  startedAt: new Date().toISOString(),
  node: process.version,
  sdkResolved: sdkPath,
  importProbe: {
    status: importProbe.status,
    stdout: (importProbe.stdout ?? "").trim(),
    stderr: (importProbe.stderr ?? "").trim().slice(0, 1000),
  },
  bun: {
    available: bun.status === 0,
    version: (bun.stdout ?? "").trim() || null,
    note: "Not required. Node-compatible is the source target.",
  },
  ok: importProbe.status === 0,
};
writeFileSync(join(artifactDir, "packaging-spike-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
process.exitCode = summary.ok ? 0 : 1;

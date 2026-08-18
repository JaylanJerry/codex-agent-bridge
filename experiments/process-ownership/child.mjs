import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const heartbeat = process.argv[2];
const pidPath = process.argv[3];
if (!heartbeat || !pidPath) {
  console.error("usage: child.mjs <heartbeatPath> <pidPath>");
  process.exit(2);
}

writeFileSync(pidPath, `${process.pid}\n`);
const tick = () => {
  writeFileSync(heartbeat, `${Date.now()}\n`);
};
tick();
setInterval(tick, 200);

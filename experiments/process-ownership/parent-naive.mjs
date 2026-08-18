import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const childPath = process.argv[2];
const heartbeat = process.argv[3];
const pidPath = process.argv[4];
const parentPidPath = process.argv[5];

writeFileSync(parentPidPath, `${process.pid}\n`);
const child = spawn(process.execPath, [childPath, heartbeat, pidPath], {
  stdio: "ignore",
  windowsHide: true,
  detached: false,
});
if (!child.pid) process.exit(3);
setTimeout(() => process.exit(0), 400);

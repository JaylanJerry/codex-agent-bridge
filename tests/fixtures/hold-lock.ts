import { writeFileSync } from "node:fs";
import { acquireCoreLock } from "../../src/persistence/lock.ts";

const dataDir = process.argv[2];
const readyPath = process.argv[3];
if (!dataDir || !readyPath) {
  throw new Error("usage: hold-lock.ts <dataDir> <readyPath>");
}
acquireCoreLock(dataDir);
writeFileSync(readyPath, "ready\n");
setInterval(() => {
  // keep the process alive until the parent kills it
}, 1 << 30);

import { runSetup } from "../src/install/setup.ts";

await runSetup({
  dev: true,
  writeMcp: process.argv.includes("--write-mcp"),
  printOnly: !process.argv.includes("--write-mcp"),
});

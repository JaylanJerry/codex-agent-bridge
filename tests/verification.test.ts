import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runVerification } from "../src/verification/runner.ts";

test("Verification Runner only executes allowlisted verifyIds", () => {
  const root = mkdtempSync(join(tmpdir(), "ab-verify-"));
  mkdirSync(join(root, ".agent-bridge"), { recursive: true });
  writeFileSync(
    join(root, ".agent-bridge", "verify.json"),
    JSON.stringify({
      schemaVersion: "1.0",
      commands: {
        ok: { exe: process.execPath, args: ["-e", "process.stdout.write('ok')"] },
      },
    }),
  );
  const passed = runVerification(root, ["ok"]);
  assert.equal(passed.passed, true);
  assert.match(passed.output, /ok/);
  const unknown = runVerification(root, ["rm-rf"]);
  assert.equal(unknown.passed, false);
  assert.match(unknown.output, /unknown verifyId/);
  rmSync(root, { recursive: true, force: true });
});

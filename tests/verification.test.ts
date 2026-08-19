import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runVerification, parseVerificationPlan } from "../src/verification/runner.ts";

test("Verification Runner only executes allowlisted verifyIds from the immutable plan", () => {
  const root = mkdtempSync(join(tmpdir(), "ab-verify-"));
  mkdirSync(join(root, ".agent-bridge"), { recursive: true });
  const raw = JSON.stringify({
    schemaVersion: "1.0",
    commands: {
      ok: { exe: process.execPath, args: ["-e", "process.stdout.write('ok')"] },
    },
  });
  writeFileSync(join(root, ".agent-bridge", "verify.json"), raw);
  const plan = parseVerificationPlan(raw);
  const passed = runVerification(root, ["ok"], plan, true);
  assert.equal(passed.passed, true);
  assert.match(passed.output, /ok/);
  const unknown = runVerification(root, ["rm-rf"], plan, true);
  assert.equal(unknown.passed, false);
  assert.match(unknown.output, /unknown verifyId/);
  writeFileSync(
    join(root, ".agent-bridge", "verify.json"),
    JSON.stringify({ commands: { ok: { exe: process.execPath, args: ["-e", "process.stdout.write('tampered')"] } } }),
  );
  const stillOriginal = runVerification(root, ["ok"], plan, true);
  assert.match(stillOriginal.output, /ok/);
  assert.equal(stillOriginal.output.includes("tampered"), false);
  const missing = runVerification(root, ["ok"], undefined, true);
  assert.equal(missing.passed, false);
  assert.match(missing.output, /VERIFICATION_PLAN_MISSING/);
  rmSync(root, { recursive: true, force: true });
});

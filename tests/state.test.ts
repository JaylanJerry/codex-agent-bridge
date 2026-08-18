import { test } from "node:test";
import assert from "node:assert/strict";
import { transition } from "../src/core/state.ts";

test("allows worker turn to review", () => {
  assert.equal(transition("QUEUED", "STARTING"), "STARTING");
  assert.equal(transition("STARTING", "RUNNING"), "RUNNING");
  assert.equal(transition("RUNNING", "VERIFYING"), "VERIFYING");
  assert.equal(transition("VERIFYING", "AWAITING_REVIEW"), "AWAITING_REVIEW");
});

test("approve path", () => {
  assert.equal(transition("AWAITING_REVIEW", "FINALIZING"), "FINALIZING");
  assert.equal(transition("FINALIZING", "COMPLETED"), "COMPLETED");
});

test("rejects illegal jumps", () => {
  assert.throws(() => transition("COMPLETED", "RUNNING"));
  assert.throws(() => transition("QUEUED", "COMPLETED"));
});

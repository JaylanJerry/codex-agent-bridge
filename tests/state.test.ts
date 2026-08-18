import { test } from "node:test";
import assert from "node:assert/strict";
import { needsAttention, transition } from "../src/core/state.ts";

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
  assert.equal(transition("QUEUED", "AWAITING_REVIEW"), "AWAITING_REVIEW");
  assert.equal(transition("STARTING", "AWAITING_REVIEW"), "AWAITING_REVIEW");
  assert.equal(transition("RUNNING", "TASK_TIMED_OUT"), "TASK_TIMED_OUT");
  assert.equal(transition("TASK_TIMED_OUT", "RUNNING"), "RUNNING");
  assert.throws(() => transition("COMPLETED", "RUNNING"));
  assert.throws(() => transition("QUEUED", "COMPLETED"));
});

test("needs-attention covers review, failure, timeout, and interrupted", () => {
  const base = {
    taskId: "t",
    clientRequestId: "r",
    stateVersion: 1,
    verdict: null,
    interrupted: false,
    objective: "x",
    projectPath: "/tmp",
    workerId: "replay",
  } as const;
  assert.equal(needsAttention({ ...base, state: "WAITING_FOR_INPUT" }), true);
  assert.equal(needsAttention({ ...base, state: "FAILED" }), true);
  assert.equal(needsAttention({ ...base, state: "TASK_TIMED_OUT" }), true);
  assert.equal(needsAttention({ ...base, state: "RUNNING", interrupted: true }), true);
  assert.equal(needsAttention({ ...base, state: "COMPLETED" }), false);
  assert.equal(needsAttention({ ...base, state: "CANCELLED" }), false);
  assert.equal(needsAttention({ ...base, state: "CANCELLED", interrupted: true }), false);
  assert.equal(needsAttention({ ...base, state: "COMPLETED", interrupted: true }), false);
});

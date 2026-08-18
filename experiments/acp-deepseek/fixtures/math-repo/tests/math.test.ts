import assert from "node:assert/strict";
import { test } from "node:test";
import { add, sub } from "../src/math.ts";

test("add returns the sum of two positive numbers", () => {
  assert.equal(add(2, 3), 5);
});

test("sub returns the difference of two positive numbers", () => {
  assert.equal(sub(5, 2), 3);
});

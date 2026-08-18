import assert from "node:assert/strict";
import test from "node:test";
import { add } from "../src/math.ts";

test("add returns the sum of two positive numbers", () => {
  assert.equal(add(2, 3), 5);
});

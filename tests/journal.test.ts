import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal } from "../src/persistence/journal.ts";
import { redact } from "../src/persistence/redact.ts";

test("redact strips API keys from objects and inline strings", () => {
  const hidden = redact({
    DEEPSEEK_API_KEY: "sk-live-secretvalue",
    nested: { authorization: "Bearer tok" },
    note: "export DEEPSEEK_API_KEY=sk-live-secretvalue",
  });
  const text = JSON.stringify(hidden);
  assert.equal(text.includes("sk-live-secretvalue"), false);
  assert.match(text, /\[redacted\]/);
});

test("journal append redacts payloads on disk", () => {
  const root = mkdtempSync(join(tmpdir(), "ab-journal-"));
  const path = join(root, "journal.ndjson");
  const journal = new Journal(path);
  journal.append("run", { env: { DEEPSEEK_API_KEY: "sk-should-not-leak" } }, "task-1");
  const raw = readFileSync(path, "utf8");
  assert.equal(raw.includes("sk-should-not-leak"), false);
  assert.match(raw, /\[redacted\]/);
  rmSync(root, { recursive: true, force: true });
});

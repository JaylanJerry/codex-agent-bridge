#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const stateDir = resolve(root, ".state");
const statePath = resolve(stateDir, "task.json");

function json(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

const command = process.argv[2] ?? "help";
const waitMs = Number(process.env.BRIDGE_PROBE_WAIT_MS ?? "8000");

if (command === "start") {
  mkdirSync(stateDir, { recursive: true });
  const task = {
    taskId: `probe-${Date.now()}`,
    state: "running",
    startedAt: new Date().toISOString(),
  };
  writeFileSync(statePath, `${JSON.stringify(task, null, 2)}\n`);
  json({ ok: true, ...task });
  process.exit(0);
}

if (command === "wait") {
  const started = Date.now();
  let task = { taskId: "anonymous", state: "running" };
  try {
    task = JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    mkdirSync(stateDir, { recursive: true });
    task = { taskId: `probe-${started}`, state: "running", startedAt: new Date().toISOString() };
    writeFileSync(statePath, `${JSON.stringify(task, null, 2)}\n`);
  }
  await sleep(waitMs);
  const result = {
    ok: true,
    taskId: task.taskId,
    state: "done",
    waitMs,
    elapsedMs: Date.now() - started,
    finishedAt: new Date().toISOString(),
  };
  writeFileSync(statePath, `${JSON.stringify(result, null, 2)}\n`);
  json(result);
  process.exit(0);
}

json({
  ok: false,
  error: "usage: bridge-probe start|wait",
});
process.exit(1);

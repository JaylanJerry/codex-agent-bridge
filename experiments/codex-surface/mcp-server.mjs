#!/usr/bin/env node
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const cli = resolve(dirname(fileURLToPath(import.meta.url)), "cli.mjs");
let nextId = 0;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function fail(id, message) {
  send({ jsonrpc: "2.0", id, error: { code: -32000, message } });
}

function runCli(args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: process.env,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolveRun(JSON.parse(stdout.trim().split(/\n/).at(-1)));
      } else {
        reject(new Error(stderr || `cli exited ${code}`));
      }
    });
  });
}

const tools = [
  {
    name: "probe_start",
    description: "Start a fake long-running bridge probe task and return structured JSON.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "probe_wait",
    description: "Wait for the fake bridge probe task to finish and return structured JSON.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = message;
  if (method === "initialize") {
    reply(id, {
      protocolVersion: params?.protocolVersion ?? "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "bridge-probe", version: "0.1.0" },
    });
    return;
  }
  if (method === "notifications/initialized" || method === "initialized") return;
  if (method === "tools/list") {
    reply(id, { tools });
    return;
  }
  if (method === "ping") {
    reply(id ?? ++nextId, {});
    return;
  }
  if (method === "tools/call") {
    try {
      const name = params?.name;
      const payload = await runCli(name === "probe_start" ? ["start"] : ["wait"]);
      reply(id, {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structuredContent: payload,
        isError: false,
      });
    } catch (error) {
      fail(id, error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (id !== undefined) fail(id, `unknown method ${method}`);
});

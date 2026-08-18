import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const serverPath = resolve(dirname(fileURLToPath(import.meta.url)), "mcp-server.mjs");

export function callMcp(method, params, env = {}) {
  return new Promise((resolveCall, reject) => {
    const child = spawn(process.execPath, [serverPath], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const pending = new Map();
    let nextId = 1;
    const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      const lines = stdout.split(/\n/);
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          if (message.id !== undefined && pending.has(message.id)) {
            pending.get(message.id)(message);
          }
        } catch {
          // ignore non-json
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);

    const request = (rpcMethod, rpcParams) =>
      new Promise((resolveReq, rejectReq) => {
        const id = nextId++;
        pending.set(id, resolveReq);
        send({ jsonrpc: "2.0", id, method: rpcMethod, params: rpcParams });
        setTimeout(() => rejectReq(new Error(`${rpcMethod} timed out`)), 20000);
      });

    (async () => {
      try {
        const initialize = await request("initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "phase0", version: "0.1.0" },
        });
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        const listed = await request("tools/list", {});
        const called = await request("tools/call", { name: method, arguments: params ?? {} });
        child.kill("SIGTERM");
        resolveCall({
          initialize: initialize.result,
          tools: listed.result?.tools?.map((tool) => tool.name),
          call: called.result,
          stderr,
        });
      } catch (error) {
        child.kill("SIGKILL");
        reject(error);
      }
    })();
  });
}

if (process.argv[1] && process.argv[1].endsWith("mcp-client.mjs")) {
  const started = Date.now();
  const start = await callMcp("probe_start");
  const wait = await callMcp("probe_wait", {}, { BRIDGE_PROBE_WAIT_MS: "1000" });
  process.stdout.write(
    `${JSON.stringify({ elapsedMs: Date.now() - started, start, wait }, null, 2)}\n`,
  );
}

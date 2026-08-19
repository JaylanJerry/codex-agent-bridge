#!/usr/bin/env node
import { createInterface } from "node:readline";
import { dispatch, type BridgeRequest, type BridgeResult } from "../api/client.ts";
import { buildMcpTools } from "./tools.ts";

const PROTOCOL_VERSION = "2024-11-05";

type JsonRpc = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: {
    protocolVersion?: string;
    name?: string;
    arguments?: Record<string, unknown>;
  };
};

const tools = buildMcpTools();

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id: number | string | undefined, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function fail(id: number | string | undefined, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code: -32000, message } });
}

function toolResult(payload: BridgeResult) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: !payload.ok,
  };
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function toRequest(name: string, args: Record<string, unknown> = {}): BridgeRequest {
  const command = name.replace(/^bridge_/, "").replaceAll("_", "-");
  return {
    command,
    project: firstString(args.project, args.projectPath),
    objective: typeof args.objective === "string" ? args.objective : undefined,
    worker: typeof args.worker === "string" ? args.worker : undefined,
    task: firstString(args.task, args.taskId),
    notes: typeof args.notes === "string" ? args.notes : undefined,
    clientRequestId: typeof args.clientRequestId === "string" ? args.clientRequestId : undefined,
    stateVersion: typeof args.stateVersion === "number" ? args.stateVersion : undefined,
    inPlace: args.inPlace === true,
    verifyIds: Array.isArray(args.verifyIds) ? args.verifyIds.map(String) : undefined,
    files:
      args.files && typeof args.files === "object"
        ? Object.fromEntries(Object.entries(args.files as Record<string, unknown>).map(([key, value]) => [key, String(value)]))
        : undefined,
    timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : undefined,
    needsAttention: args.needsAttention === true,
    permissionMode: args.permissionMode === "auto" ? "auto" : "gate",
    optionId: typeof args.optionId === "string" ? args.optionId : undefined,
  };
}

function missingRequired(name: string, args: Record<string, unknown>): string[] {
  const tool = tools.find((item) => item.name === name);
  const required = (tool?.inputSchema as { required?: string[] } | undefined)?.required ?? [];
  return required.filter((key) => {
    if (key === "task") return !firstString(args.task, args.taskId);
    if (key === "project") return !firstString(args.project, args.projectPath);
    const value = args[key];
    return value === undefined || value === null || value === "";
  });
}

const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let message: JsonRpc;
  try {
    message = JSON.parse(line) as JsonRpc;
  } catch {
    return;
  }
  const { id, method, params } = message;
  if (method === "initialize") {
    reply(id, {
      protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "agent-bridge", version: "1.0.0" },
    });
    return;
  }
  if (method === "notifications/initialized" || method === "initialized") return;
  if (method === "ping") {
    reply(id ?? 0, {});
    return;
  }
  if (method === "tools/list") {
    reply(id, { tools });
    return;
  }
  if (method === "tools/call") {
    try {
      const name = params?.name;
      if (!name || !tools.some((tool) => tool.name === name)) {
        fail(id, `unknown tool ${name}`);
        return;
      }
      const args = params?.arguments ?? {};
      const missing = missingRequired(name, args);
      if (missing.length > 0) {
        reply(
          id,
          toolResult({
            ok: false,
            code: "MISSING_ARGUMENT",
            error:
              missing.includes("task")
                ? `missing ${missing.join(", ")} (pass the task UUID in field "task")`
                : `missing ${missing.join(", ")}`,
          }),
        );
        return;
      }
      const payload = await dispatch(toRequest(name, args));
      reply(id, toolResult(payload));
    } catch (error) {
      fail(id, error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (id !== undefined) fail(id, `unknown method ${method}`);
});

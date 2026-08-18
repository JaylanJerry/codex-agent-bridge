#!/usr/bin/env node
import { createInterface } from "node:readline";
import { dispatch, type BridgeRequest, type BridgeResult } from "../api/client.ts";

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

const tools = [
  {
    name: "bridge_run",
    description:
      "Start an Agent Bridge task and wait until WAITING_FOR_INPUT, AWAITING_REVIEW, or TASK_TIMED_OUT. None of these is completion. WAITING_FOR_INPUT needs bridge_respond. TASK_TIMED_OUT means the wait budget expired; worker is stopped and worktree is kept.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Git repo path" },
        objective: { type: "string" },
        worker: { type: "string", description: "replay | claude | deepseek | fake" },
        clientRequestId: { type: "string" },
        inPlace: { type: "boolean" },
        verifyIds: { type: "array", items: { type: "string" } },
        files: { type: "object", additionalProperties: { type: "string" } },
        timeoutMs: {
          type: "number",
          description:
            "Wait budget in ms. Default 900000. On expiry the worker is stopped, worktree is kept, and state becomes TASK_TIMED_OUT.",
        },
        permissionMode: {
          type: "string",
          enum: ["auto", "gate"],
          description: "auto selects allow_once. gate pauses at WAITING_FOR_INPUT for bridge_respond. MCP default is gate.",
        },
      },
      required: ["project", "objective"],
      additionalProperties: false,
    },
  },
  {
    name: "bridge_status",
    description: "Get one task or list all tasks for a project.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        task: { type: "string" },
        needsAttention: {
          type: "boolean",
          description:
            "If true, only return tasks that still need a Supervisor decision: AWAITING_REVIEW, WAITING_FOR_INPUT, FAILED, TASK_TIMED_OUT, or interrupted in-flight. CANCELLED and COMPLETED are excluded even if interrupted.",
        },
      },
      required: ["project"],
      additionalProperties: false,
    },
  },
  {
    name: "bridge_wait",
    description:
      "Wait until WAITING_FOR_INPUT, AWAITING_REVIEW, TASK_TIMED_OUT, or a terminal state. Wait budget expiry stops the worker and returns TASK_TIMED_OUT instead of throwing.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        task: { type: "string" },
        timeoutMs: { type: "number" },
      },
      required: ["project", "task"],
      additionalProperties: false,
    },
  },
  {
    name: "bridge_review_packet",
    description: "Build a ReviewPacket from the current worktree vs baseCommit. Required before approve.",
    inputSchema: {
      type: "object",
      properties: { project: { type: "string" }, task: { type: "string" } },
      required: ["project", "task"],
      additionalProperties: false,
    },
  },
  {
    name: "bridge_diff",
    description: "Return git diff of the task worktree against baseCommit.",
    inputSchema: {
      type: "object",
      properties: { project: { type: "string" }, task: { type: "string" } },
      required: ["project", "task"],
      additionalProperties: false,
    },
  },
  {
    name: "bridge_continue",
    description:
      "Send revision notes to the same task from AWAITING_REVIEW or TASK_TIMED_OUT. Requires expectedStateVersion.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        task: { type: "string" },
        notes: { type: "string" },
        stateVersion: { type: "number" },
        files: { type: "object", additionalProperties: { type: "string" } },
        worker: { type: "string" },
        timeoutMs: { type: "number" },
        permissionMode: { type: "string", enum: ["auto", "gate"] },
      },
      required: ["project", "task", "notes", "stateVersion"],
      additionalProperties: false,
    },
  },
  {
    name: "bridge_respond",
    description:
      "Answer a WAITING_FOR_INPUT permission prompt. Always pass project and task (the task UUID; field name is task). optionId comes from pendingInput.options (Claude may be allow). Requires stateVersion. Then waits until the next prompt or AWAITING_REVIEW.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Git repo path used in bridge_run." },
        projectPath: { type: "string", description: "Alias of project." },
        task: { type: "string", description: "Task UUID. Field name is task, not taskId." },
        taskId: { type: "string", description: "Alias of task." },
        stateVersion: { type: "number" },
        optionId: { type: "string", description: "Permission optionId, or cancelled" },
        timeoutMs: { type: "number" },
      },
      required: ["project", "task", "stateVersion", "optionId"],
      additionalProperties: false,
    },
  },
  {
    name: "bridge_approve",
    description: "Approve the reviewed ChangeSet and create a checkpoint commit on the task branch. Does not merge main.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        task: { type: "string" },
        stateVersion: { type: "number" },
      },
      required: ["project", "task", "stateVersion"],
      additionalProperties: false,
    },
  },
  {
    name: "bridge_reject",
    description: "Reject the task. Requires expectedStateVersion.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        task: { type: "string" },
        stateVersion: { type: "number" },
      },
      required: ["project", "task", "stateVersion"],
      additionalProperties: false,
    },
  },
  {
    name: "bridge_cancel",
    description: "Cancel a running or reviewed task. Requires expectedStateVersion.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        task: { type: "string" },
        stateVersion: { type: "number" },
      },
      required: ["project", "task", "stateVersion"],
      additionalProperties: false,
    },
  },
  {
    name: "bridge_apply",
    description:
      "Cherry-pick an approved checkpoint onto the current branch of project. Does not merge. Requires COMPLETED + approvedCommit + stateVersion.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        task: { type: "string" },
        stateVersion: { type: "number" },
      },
      required: ["project", "task", "stateVersion"],
      additionalProperties: false,
    },
  },
  {
    name: "bridge_logs",
    description: "Return journal events for a project, optionally filtered by task. Secrets are redacted.",
    inputSchema: {
      type: "object",
      properties: { project: { type: "string" }, task: { type: "string" } },
      required: ["project"],
      additionalProperties: false,
    },
  },
  {
    name: "bridge_prune",
    description:
      "Remove leftover agent-bridge git worktrees that are not owned by an in-flight task. Does not delete task branches or checkpoints. Never touches AWAITING_REVIEW / RUNNING worktrees.",
    inputSchema: {
      type: "object",
      properties: { project: { type: "string" } },
      required: ["project"],
      additionalProperties: false,
    },
  },
  {
    name: "bridge_doctor",
    description:
      "Check git, Node, Job Object, worker adapters, credential presence (not values), Codex MCP registration, and optional orphan worktrees.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Optional target git repo for verify.json and orphan worktree checks." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bridge_agents",
    description: "List Worker profiles and whether they are available on this machine. Does not print secrets.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "bridge_version",
    description: "Return the Agent Bridge package version.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

for (const tool of tools) {
  const props = (
    tool.inputSchema as { properties?: Record<string, { type?: string; description?: string }> }
  ).properties;
  if (!props) continue;
  if (props.task && !props.taskId) {
    props.taskId = { type: "string", description: "Alias of task (the task UUID)." };
  }
  if (props.project && !props.projectPath) {
    props.projectPath = { type: "string", description: "Alias of project." };
  }
}

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

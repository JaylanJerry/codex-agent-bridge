import { debugWorkersAllowed } from "../workers/debug.ts";

type JsonSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties: false;
};

export type McpTool = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
};

function withAliases(tools: McpTool[]): McpTool[] {
  for (const tool of tools) {
    const props = tool.inputSchema.properties;
    if (props.task && !props.taskId) {
      props.taskId = { type: "string", description: "Alias of task (the task UUID)." };
    }
    if (props.project && !props.projectPath) {
      props.projectPath = { type: "string", description: "Alias of project." };
    }
  }
  return tools;
}

export function buildMcpTools(debug = debugWorkersAllowed()): McpTool[] {
  const runProperties: Record<string, unknown> = {
    project: { type: "string", description: "Git repo path" },
    objective: { type: "string" },
    worker: debug
      ? { type: "string", description: "claude | deepseek. replay/fake only in test/dev." }
      : { type: "string", enum: ["claude", "deepseek"] },
    clientRequestId: { type: "string" },
    verifyIds: { type: "array", items: { type: "string" } },
    timeoutMs: {
      type: "number",
      description:
        "Wait budget in ms. Default 900000. On expiry the worker is stopped, worktree is kept, and state becomes TASK_TIMED_OUT.",
    },
    permissionMode: {
      type: "string",
      enum: ["auto", "gate"],
      description:
        "auto selects allow_once. gate pauses at WAITING_FOR_INPUT for bridge_respond. MCP default is gate.",
    },
  };
  if (debug) {
    runProperties.inPlace = { type: "boolean", description: "Dev/test only. Forbidden in production." };
    runProperties.files = {
      type: "object",
      additionalProperties: { type: "string" },
      description: "Dev/test replay only.",
    };
  }

  const continueProperties: Record<string, unknown> = {
    project: { type: "string" },
    task: { type: "string" },
    notes: { type: "string" },
    stateVersion: { type: "number" },
    timeoutMs: { type: "number" },
  };
  if (debug) {
    continueProperties.files = {
      type: "object",
      additionalProperties: { type: "string" },
      description: "Dev/test replay only.",
    };
  }

  return withAliases([
    {
      name: "bridge_run",
      description:
        "Start an Agent Bridge task and wait until WAITING_FOR_INPUT, AWAITING_REVIEW, or TASK_TIMED_OUT. None of these is completion. WAITING_FOR_INPUT needs bridge_respond. TASK_TIMED_OUT means the wait budget expired; worker is stopped and worktree is kept.",
      inputSchema: {
        type: "object",
        properties: runProperties,
        required: ["project", "objective", "worker"],
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
        "Send revision notes to the same task from AWAITING_REVIEW or TASK_TIMED_OUT. Requires expectedStateVersion. Does not change the worker.",
      inputSchema: {
        type: "object",
        properties: continueProperties,
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
        "Check git, Node, Job Object, worker adapters, credential presence (not values), Codex MCP registration, and optional orphan worktrees. DeepSeek reports transport=acp and integration=official|legacy|missing. A source checkout is legacy, not official runtime ready.",
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
      description:
        "List Worker profiles and whether they are available on this machine. DeepSeek availability is legacy source ACP or missing; official runtime is currently unavailable. Does not print secrets.",
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
  ]);
}

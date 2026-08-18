import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultServer = resolve(dirname(fileURLToPath(import.meta.url)), "server.ts");

export type McpToolCall = {
  content?: { type: string; text?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
};

export class McpStdioClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, (message: { result?: unknown; error?: { message: string } }) => void>();
  private nextId = 1;
  private buffer = "";

  constructor(serverPath = defaultServer) {
    this.child = spawn(process.execPath, ["--import", "tsx", serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: process.env,
    }) as ChildProcessWithoutNullStreams;
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      const lines = this.buffer.split(/\n/);
      this.buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line) as { id?: number; result?: unknown; error?: { message: string } };
          if (message.id !== undefined && this.pending.has(message.id)) {
            this.pending.get(message.id)!(message);
            this.pending.delete(message.id);
          }
        } catch {
          // ignore non-JSON
        }
      }
    });
  }

  async request(method: string, params: unknown = {}, timeoutMs = 900_000): Promise<unknown> {
    const id = this.nextId++;
    const result = new Promise((resolveReq, rejectReq) => {
      const timer = setTimeout(() => rejectReq(new Error(`${method} timed out`)), timeoutMs);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.error) rejectReq(new Error(message.error.message));
        else resolveReq(message.result);
      });
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return result;
  }

  notify(method: string, params: unknown = {}): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async initialize(): Promise<unknown> {
    const result = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "agent-bridge-test", version: "0.5.0" },
    });
    this.notify("notifications/initialized");
    return result;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCall> {
    return (await this.request("tools/call", { name, arguments: args })) as McpToolCall;
  }

  close(): void {
    this.child.kill();
  }
}

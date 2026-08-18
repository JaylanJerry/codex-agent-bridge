import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const sessions = new Map<string, { cwd: string; cancelled: boolean }>();

function textOf(prompt: Array<{ type: string; text?: string }> | undefined): string {
  return (prompt ?? [])
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
}

process.stdin.resume();

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
);

const connection = new acp.AgentSideConnection((conn) => {
  return {
    async initialize(params) {
      return {
        protocolVersion: params.protocolVersion,
        agentCapabilities: { loadSession: true },
        agentInfo: { name: "fake-acp", version: "0.1.0" },
      };
    },
    async authenticate() {
      return {};
    },
    async newSession(params) {
      const sessionId = `fake-${sessions.size + 1}`;
      sessions.set(sessionId, { cwd: params.cwd, cancelled: false });
      return { sessionId };
    },
    async loadSession(params) {
      sessions.set(params.sessionId, { cwd: params.cwd, cancelled: false });
      return {};
    },
    async prompt(params) {
      const session = sessions.get(params.sessionId);
      if (!session) throw new Error("unknown session");
      session.cancelled = false;
      const text = textOf(params.prompt);
      if (text.includes("CANCEL_WAIT")) {
        const deadline = Date.now() + 8_000;
        while (Date.now() < deadline) {
          if (session.cancelled) return { stopReason: "cancelled" as const };
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return { stopReason: "end_turn" as const };
      }
      if (text.includes("ASK_PERMISSION")) {
        const permission = await conn.requestPermission({
          sessionId: params.sessionId,
          toolCall: { toolCallId: "write-1", title: "Write file", kind: "edit" },
          options: [
            { optionId: "allow-once", kind: "allow_once", name: "Allow once" },
            { optionId: "reject-once", kind: "reject_once", name: "Reject once" },
          ],
        });
        const allowed =
          permission.outcome.outcome === "selected" &&
          permission.outcome.optionId === "allow-once";
        if (!allowed) return { stopReason: "end_turn" as const };
      }
      const writeMatch = text.match(/^WRITE\s+(\S+)\n([\s\S]*)$/m);
      if (writeMatch) {
        const target = resolve(session.cwd, writeMatch[1]);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, writeMatch[2]);
      } else {
        writeFileSync(join(session.cwd, "turn.txt"), text);
      }
      return { stopReason: "end_turn" as const };
    },
    async cancel(params) {
      const session = sessions.get(params.sessionId);
      if (session) session.cancelled = true;
    },
  };
}, stream);

await connection.closed;

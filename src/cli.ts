#!/usr/bin/env node
import { dispatch, type BridgeRequest } from "./api/client.ts";

type FlagMap = {
  command: string;
  values: Record<string, string>;
  lists: Record<string, string[]>;
};

function parseArgv(argv: string[]): FlagMap {
  const [command, ...rest] = argv;
  const values: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = rest[i + 1];
    if (!next || next.startsWith("--")) {
      values[key] = "true";
      continue;
    }
    i += 1;
    if (!lists[key]) lists[key] = [];
    lists[key].push(next);
    values[key] = next;
  }
  return { command: command ?? "help", values, lists };
}

function decodeContents(raw: string): string {
  return raw.replaceAll("\\n", "\n").replaceAll("\\t", "\t");
}

function parseWrites(flags: FlagMap): Record<string, string> {
  const files: Record<string, string> = {};
  for (const item of flags.lists.write ?? []) {
    const idx = item.indexOf("=");
    if (idx <= 0) throw new Error(`--write expects path=contents, got ${item}`);
    files[item.slice(0, idx)] = decodeContents(item.slice(idx + 1));
  }
  return files;
}

function toRequest(flags: FlagMap): BridgeRequest {
  return {
    command: flags.command,
    project: flags.values.project,
    objective: flags.values.objective,
    worker: flags.values.worker,
    task: flags.values.task,
    notes: flags.values.notes,
    clientRequestId: flags.values["client-request-id"],
    stateVersion: flags.values["state-version"] ? Number(flags.values["state-version"]) : undefined,
    inPlace: flags.values["in-place"] === "true",
    verifyIds: flags.lists.verify,
    files: parseWrites(flags),
    timeoutMs: flags.values["timeout-ms"] ? Number(flags.values["timeout-ms"]) : undefined,
    needsAttention: flags.values["needs-attention"] === "true",
    permissionMode: flags.values["permission-mode"] === "gate" ? "gate" : "auto",
    optionId: flags.values["option-id"],
  };
}

const result = await dispatch(toRequest(parseArgv(process.argv.slice(2))));
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);

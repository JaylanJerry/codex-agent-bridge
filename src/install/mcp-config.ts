export function mcpSnippet(opts: {
  node: string;
  server: string;
  cwd: string;
  nodePath: string;
}): string {
  return `[mcp_servers.agent-bridge]
command = ${JSON.stringify(opts.node)}
args = ["--import", "tsx", ${JSON.stringify(opts.server)}]
cwd = ${JSON.stringify(opts.cwd)}
startup_timeout_sec = 30

[mcp_servers.agent-bridge.env]
NODE_PATH = ${JSON.stringify(opts.nodePath)}
`;
}

export function stripAgentBridgeMcp(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (/^\[mcp_servers\.agent-bridge(?:\.|\])/.test(line)) {
      skipping = true;
      continue;
    }
    if (skipping && /^\[/.test(line)) skipping = false;
    if (!skipping) out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

export function upsertAgentBridgeMcp(existing: string, snippet: string): string {
  const body = stripAgentBridgeMcp(existing);
  const block = snippet.trim();
  if (!body) return `${block}\n`;
  return `${body}\n\n${block}\n`;
}

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function loadDeepseekApiKey(): string {
  const fromEnv = process.env.DEEPSEEK_API_KEY?.trim();
  if (fromEnv) return fromEnv;

  const credentialPath = join(homedir(), ".dsh", ".credentials.yaml");
  const text = readFileSync(credentialPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^DEEPSEEK_API_KEY:\s*(.+)\s*$/);
    if (!match) continue;
    const value = match[1].replace(/^['"]|['"]$/g, "").trim();
    if (value) return value;
  }

  throw new Error("DEEPSEEK_API_KEY missing from env and ~/.dsh/.credentials.yaml");
}

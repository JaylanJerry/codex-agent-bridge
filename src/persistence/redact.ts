const SECRET_KEY =
  /(api[_-]?key|access[_-]?token|auth(orization)?|secret|password|credential|private[_-]?key)$/i;

const SECRET_INLINE =
  /(?:DEEPSEEK_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|CLAUDE_API_KEY)\s*[=:]\s*\S+/gi;

const TOKENISH = /\bsk-[A-Za-z0-9_-]{8,}\b/g;

export function redact(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(SECRET_INLINE, (match) => `${match.split(/[=:]/, 1)[0]}=[redacted]`).replace(TOKENISH, "[redacted]");
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key) ? "[redacted]" : redact(nested);
    }
    return out;
  }
  return value;
}

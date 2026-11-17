const SECRET_TEXT_PATTERNS = [
  /((?:authorization)\s*[:=]\s*(?:bearer|basic)\s+)[A-Za-z0-9+/=._~-]+/gi,
  /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|client[_-]?secret|password|secret|credential|private[_-]?key|cookie|set-cookie)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s"'&,;]+)/gi,
  /(\b)(sk-ant-[A-Za-z0-9_-]{12,})\b/g,
  /(\b)(sk-[A-Za-z0-9_-]{24,})\b/g
] as const;

/** Redact secrets without changing report length limits or truncating handoffs. */
export function redactSecrets(value: string): string {
  let result = value;
  for (const pattern of SECRET_TEXT_PATTERNS) {
    result = result.replace(pattern, (...matches: unknown[]) => {
      const prefix = typeof matches[1] === "string" ? matches[1] : "";
      return prefix + "[REDACTED]";
    });
  }
  return result;
}

/** Redact raw engine output before it reaches bounded persistent logs or UI events. */
export function sanitizeText(value: string): string {
  return redactSecrets(value).slice(0, 12000);
}

/** Redact credential-bearing JSON keys as well as secret values nested in strings. */
export function safeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safeJson);
  if (!value || typeof value !== "object") {
    return typeof value === "string" ? redactSecrets(value) : value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (/token|password|secret|authorization|api.?key|credential|private.?key|cookie/i.test(key)) {
      output[key] = "[REDACTED]";
    } else {
      output[key] = safeJson(entry);
    }
  }
  return output;
}

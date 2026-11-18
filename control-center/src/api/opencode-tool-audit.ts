import { safeJson, sanitizeText } from "./redaction.js";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function parseExitCode(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value);
  return undefined;
}

/**
 * Adds a bounded, redacted execution receipt for OpenCode shell calls.
 * Other tools intentionally keep the existing compact audit event.
 */
export function summarizeOpenCodeToolResult(toolName: string, rawState: unknown): string {
  if (toolName !== "shell") return "";

  const state = asRecord(rawState);
  const metadata = asRecord(state.metadata);
  const time = asRecord(state.time);
  const rawOutput = typeof state.output === "string" ? state.output : "";
  const output = sanitizeText(rawOutput).slice(-5000);
  const error = typeof state.error === "string" ? sanitizeText(state.error).slice(-3000) : undefined;

  const exitCode = [
    state.exitCode,
    state.exit,
    metadata.exitCode,
    metadata.exit
  ].map(parseExitCode).find((candidate) => candidate !== undefined)
    ?? (() => {
      const match = output.match(/(?:exit(?:ed)?(?:\s+with)?(?:\s+code)?|process\s+code)\s*[:=]?\s*(-?\d+)/i);
      return match ? Number(match[1]) : undefined;
    })();

  const start = typeof time.start === "number" ? time.start : undefined;
  const end = typeof time.end === "number" ? time.end : undefined;
  const durationMs = start !== undefined && end !== undefined && end >= start
    ? end - start
    : undefined;

  const audit = {
    exitCode: exitCode ?? null,
    durationMs: durationMs ?? null,
    title: typeof state.title === "string" ? sanitizeText(state.title).slice(0, 300) : undefined,
    metadata: safeJson(metadata),
    output: output || undefined,
    error
  };
  return " · resultado-shell=" + JSON.stringify(audit);
}

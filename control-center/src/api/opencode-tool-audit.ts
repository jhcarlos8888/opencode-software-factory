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

function extractTextContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((item) => {
    const record = asRecord(item);
    if (record.type === "text" && typeof record.text === "string") return record.text;
    if (record.type === "file") {
      const name = typeof record.name === "string" ? record.name : "adjunto";
      const mime = typeof record.mime === "string" ? record.mime : "tipo desconocido";
      return "[adjunto " + name + " · " + mime + "]";
    }
    return "";
  }).filter(Boolean).join("\n");
}

function firstString(records: UnknownRecord[], keys: string[]): string {
  for (const record of records) {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  return "";
}

/**
 * Adds a bounded, redacted execution receipt for OpenCode shell calls.
 * Supports legacy ToolStateCompleted output/time and V2 content/structured/result.
 */
export function summarizeOpenCodeToolResult(
  toolName: string,
  rawState: unknown,
  rawPartTime?: unknown
): string {
  if (toolName !== "shell") return "";

  const state = asRecord(rawState);
  const metadata = asRecord(state.metadata);
  const structured = asRecord(state.structured);
  const result = asRecord(state.result);
  const stateTime = asRecord(state.time);
  const time = Object.keys(stateTime).length ? stateTime : asRecord(rawPartTime);
  const sources = [state, structured, result, metadata];

  const contentOutput = extractTextContent(state.content) || extractTextContent(result.content);
  const stdout = firstString(sources, ["stdout", "standardOutput"]);
  const stderr = firstString(sources, ["stderr", "standardError"]);
  const rawOutput = firstString(sources, ["output", "text", "message"]) ||
    contentOutput ||
    [stdout && "[stdout]\n" + stdout, stderr && "[stderr]\n" + stderr].filter(Boolean).join("\n");
  const output = sanitizeText(rawOutput).slice(-5000);
  const errorValue = state.error ?? result.error ?? structured.error;
  const error = typeof errorValue === "string"
    ? sanitizeText(errorValue).slice(0, 3000)
    : errorValue === undefined ? undefined : sanitizeText(JSON.stringify(safeJson(errorValue))).slice(0, 3000);

  const exitCode = [
    state.exitCode, state.exit, state.exit_code,
    structured.exitCode, structured.exit, structured.exit_code,
    result.exitCode, result.exit, result.exit_code,
    metadata.exitCode, metadata.exit
  ].map(parseExitCode).find((candidate) => candidate !== undefined)
    ?? (() => {
      const match = output.match(/(?:exit(?:ed)?(?:\s+with)?(?:\s+code)?|process\s+code)\s*[:=]?\s*(-?\d+)/i);
      return match ? Number(match[1]) : undefined;
    })();

  const start = typeof time.start === "number" ? time.start
    : typeof time.ran === "number" ? time.ran
      : undefined;
  const end = typeof time.end === "number" ? time.end
    : typeof time.completed === "number" ? time.completed
      : undefined;
  const durationMs = start !== undefined && end !== undefined && end >= start
    ? end - start
    : undefined;

  const audit = {
    exitCode: exitCode ?? null,
    durationMs: durationMs ?? null,
    title: typeof state.title === "string" ? sanitizeText(state.title).slice(0, 300) : undefined,
    metadata: safeJson(metadata),
    structured: safeJson(structured),
    output: output || undefined,
    outputLength: rawOutput ? rawOutput.length : 0,
    outputTruncated: rawOutput.length > 5000 || metadata.truncated === true,
    error
  };
  return " · resultado-shell=" + JSON.stringify(audit);
}

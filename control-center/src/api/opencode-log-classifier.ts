export type OpenCodeServerLogKind = "info" | "warning";

export interface OpenCodeServerLogClassification {
  kind: OpenCodeServerLogKind;
  failure: boolean;
}

/** Classify OpenCode output by its embedded severity, not stdout/stderr routing. */
export function classifyOpenCodeServerLog(line: string, fromStderr: boolean): OpenCodeServerLogClassification {
  const level = line.match(/\blevel=(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\b/i)?.[1]?.toUpperCase();
  // The catalog refresh is asynchronous, server-wide metadata work: a
  // timeout is a warning, not evidence that any particular model turn failed.
  const catalogTimeout = /Failed to fetch models\.dev/i.test(line) &&
    /TimeoutError|timed out|fetch failed/i.test(line);
  const failure = !catalogTimeout && (level === "ERROR" || level === "FATAL" ||
    (!level && /Failed to drain Session|AI\.Error\./i.test(line)));
  const warning = level === "WARN" || level === "WARNING" || level === "ERROR" ||
    level === "FATAL" || failure ||
    (!level && fromStderr && /\b(error|failed|exception|fatal)\b/i.test(line));
  return { kind: warning ? "warning" : "info", failure };
}

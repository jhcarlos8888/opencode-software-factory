export type OpenCodeServerLogKind = "info" | "warning";

export interface OpenCodeServerLogClassification {
  kind: OpenCodeServerLogKind;
  failure: boolean;
}

/** Classify OpenCode output by its embedded severity, not stdout/stderr routing. */
export function classifyOpenCodeServerLog(line: string, fromStderr: boolean): OpenCodeServerLogClassification {
  const level = line.match(/\blevel=(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\b/i)?.[1]?.toUpperCase();
  const failure = level === "ERROR" || level === "FATAL" ||
    (!level && /Failed to drain Session|AI\.Error\./i.test(line));
  const warning = level === "WARN" || level === "WARNING" || failure ||
    (!level && fromStderr && /\b(error|failed|exception|fatal)\b/i.test(line));
  return { kind: warning ? "warning" : "info", failure };
}

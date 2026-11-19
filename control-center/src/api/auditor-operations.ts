import { isProtectedShellCommand } from "./auditor-policy.js";

export interface AuditorShellReceipt {
  id: number;
  area: string;
  message: string;
}
export interface AuditorOperationalFinding {
  evidence: number[];
  severity: "high";
  description: string;
}
export type AuditableSummary = {
  verdict: "completed" | "observations" | "failed";
  headline: string;
  overview: string;
  findings: string[];
  nextSteps: string[];
};

function readCommand(message: string): string | null {
  const marker = "TOOL shell · completed · ";
  if (!message.startsWith(marker)) return null;
  const end = message.indexOf(" · resultado-shell=", marker.length);
  if (end < 0) return null;
  try {
    const receipt = JSON.parse(message.slice(marker.length, end)) as Record<string, unknown>;
    return typeof receipt.command === "string" ? receipt.command : null;
  } catch {
    return null;
  }
}

/** Independently inspect persisted native shell receipts, not model handoffs. */
export function inspectAuditorShellReceipts(events: readonly AuditorShellReceipt[]): AuditorOperationalFinding[] {
  const dangerous = events.map((event) => ({
    id: event.id,
    command: readCommand(event.message)
  })).filter((event): event is {id: number; command: string} =>
    typeof event.command === "string" && isProtectedShellCommand(event.command)
  );
  if (!dangerous.length) return [];
  return [{
    evidence: dangerous.map((event) => event.id),
    severity: "high",
    description: "Se ejecutaron comandos de terminación o control crítico sin prueba de propiedad del proceso: " +
      dangerous.map((event) => `evento #${event.id} (${event.command.slice(0, 135)})`).join("; ") +
      ". Las pruebas funcionales verdes NO acreditan seguridad operativa. Verificar servicios afectados."
  }];
}

/** Make the auditor's objective observations authoritative over summaries by LLMs. */
export function appendAuditorOperationalFindings<T extends AuditableSummary>(summary: T, findings: readonly AuditorOperationalFinding[]): T {
  if (!findings.length) return summary;
  return {
    ...summary,
    verdict: summary.verdict === "failed" ? "failed" : "observations",
    headline: summary.verdict === "failed" ? summary.headline : "Ejecución completada con incidentes de seguridad operativa",
    overview: summary.overview + " AUDITOR DE SEGURIDAD: se detectaron operaciones de terminación de procesos en los recibos nativos, no reflejadas necesariamente por los informes de agentes. Se requiere revisión humana y verificación de salud.",
    findings: [...findings.map((f) => "[ALTA · AUDITOR] " + f.description), ...summary.findings],
    nextSteps: ["[ALTA · AUDITOR] No cerrar la ronda como segura hasta verificar los servicios y corregir la gestión de procesos temporales.", ...summary.nextSteps]
  };
}

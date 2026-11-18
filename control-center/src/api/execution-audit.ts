import { sanitizeText } from "./redaction.js";

export interface ShellExecutionEvent {
  id: number;
  area: string;
  kind: string;
  createdAt: string;
  agentRunId: string | null;
  message: string;
}

/** Format the complete persisted shell-tool trail for independent review. */
export function formatShellExecutionAuditContext(events: ShellExecutionEvent[] = []): string {
  const shellEvents = events.filter((event) =>
    event.message.includes("TOOL shell") || event.message.includes("resultado-shell=")
  );
  const lines = [
    "RECIBOS NATIVOS DE HERRAMIENTAS SHELL — EVENTOS PERSISTIDOS DE LA EJECUCIÓN ACTUAL",
    "Eventos shell encontrados: " + shellEvents.length
  ];
  if (!shellEvents.length) {
    lines.push("No se encontró ningún evento TOOL shell en el ledger consultado.");
    lines.push("No infieras ejecución ni exit code desde el handoff del agente si falta el evento nativo.");
    return lines.join("\n");
  }
  for (const event of shellEvents) {
    lines.push("SHELL_EVENT_JSON " + JSON.stringify({
      id: event.id,
      area: event.area,
      kind: event.kind,
      createdAt: event.createdAt,
      agentRunId: event.agentRunId,
      message: sanitizeText(event.message).slice(0, 9000)
    }));
  }
  lines.push("Fuente de verdad: execution_events SQLite. Contrasta command, workdir, status, output y exitCode con el handoff del Tester.");
  lines.push("Un evento running o error no acredita finalización correcta; exige TOOL shell completed y un código de salida nativo cuando esté disponible.");
  return lines.join("\n");
}

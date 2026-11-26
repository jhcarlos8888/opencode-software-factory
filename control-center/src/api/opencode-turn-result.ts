/**
 * Validate evidence from the specific OpenCode session rather than from
 * server-wide diagnostics (for example a models.dev refresh timeout).
 */
export interface OpenCodeTurnContext {
  rejectedPermission: boolean;
}
export function validateOpenCodeTurnResult(finalText: string, messages: unknown, context?: OpenCodeTurnContext): void {
  const records = Array.isArray(messages)
    ? messages
    : messages && typeof messages === "object" && Array.isArray((messages as { data?: unknown }).data)
      ? (messages as { data: unknown[] }).data
      : [];

  // A provider error attached to this session takes precedence over a text
  // handoff. Do not mistake a previous successful assistant message for the
  // outcome of a later failed turn.
  for (const entry of records.slice().reverse()) {
    if (!entry || typeof entry !== "object") continue;
    const message = entry as Record<string, unknown>;
    const info = message.info && typeof message.info === "object"
      ? message.info as Record<string, unknown>
      : {};
    const role = String(info.role ?? message.role ?? message.type ?? "");
    if (role !== "assistant") continue;
    const error = info.error ?? message.error;
    const finish = String(info.finish ?? message.finish ?? "");
    const nativeError = error && typeof error === "object" ? error as Record<string, unknown> : {};
    const parts = Array.isArray(message.parts) ? message.parts : Array.isArray(message.content) ? message.content : [];
    const deniedTool = parts.some(raw => {
      if (!raw || typeof raw !== "object") return false;
      const part = raw as Record<string, unknown>;
      const state = part.state && typeof part.state === "object" ? part.state as Record<string, unknown> : {};
      const toolError = state.error;
      return part.type === "tool" && state.status === "error" &&
        /the user declined this tool call|permission (?:denied|rejected)/i.test(typeof toolError === "string" ? toolError : JSON.stringify(toolError ?? ""));
    });
    if (context?.rejectedPermission && (deniedTool ||
        (finish === "error" && (nativeError.type === "aborted" || nativeError.name === "MessageAbortedError")))) {
      throw new Error("OpenCode interrumpió el turno al rechazarse una operación. El rechazo se conserva; no se repetirá automáticamente ni se publicará un handoff incompleto. Puedes continuar el hilo con una nueva instrucción limitada a las operaciones permitidas.");
    }
    if (error) {
      const details = typeof error === "string" ? error : JSON.stringify(error);
      throw new Error("La sesión OpenCode terminó con error de proveedor: " + details.slice(0, 1200));
    }
    // Only the most recent assistant message is relevant to terminal failure.
    break;
  }
  if (!finalText.trim()) {
    if (context?.rejectedPermission) {
      throw new Error("OpenCode terminó sin respuesta final después de una operación rechazada. No se repetirá automáticamente el turno ni se fabricará un handoff. Continúa el hilo con una nueva instrucción limitada a las operaciones permitidas.");
    }
    throw new Error("OpenCode terminó el turno sin producir una respuesta de texto. La sesión no se marcará como exitosa.");
  }
  if (/This OpenCode Go model is hosted outside|AI\.Error\.(?:InvalidRequest|Authentication|NotFound)|model.{0,80}(?:not found|not available|no access)/i.test(finalText)) {
    throw new Error("El proveedor/modelo rechazó la solicitud: " + finalText.slice(0, 3000));
  }
}

/**
 * Validate evidence from the specific OpenCode session rather than from
 * server-wide diagnostics (for example a models.dev refresh timeout).
 */
export function validateOpenCodeTurnResult(finalText: string, messages: unknown): void {
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
    if (error) {
      const details = typeof error === "string" ? error : JSON.stringify(error);
      throw new Error("La sesión OpenCode terminó con error de proveedor: " + details.slice(0, 1200));
    }
    // Only the most recent assistant message is relevant to terminal failure.
    break;
  }
  if (!finalText.trim()) {
    throw new Error("OpenCode terminó el turno sin producir una respuesta de texto. La sesión no se marcará como exitosa.");
  }
  if (/This OpenCode Go model is hosted outside|AI\.Error\.(?:InvalidRequest|Authentication|NotFound)|model.{0,80}(?:not found|not available|no access)/i.test(finalText)) {
    throw new Error("El proveedor/modelo rechazó la solicitud: " + finalText.slice(0, 3000));
  }
}

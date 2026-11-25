/** Keep provider diagnostics, but distinguish a cosmetic title-generation
 * event from model inference failures. Unknown/malformed messages stay warnings. */
export function classifyClaudeSdkLog(detail: string): { kind: "info" | "warning"; message: string } {
  const match = /^\[claude-code:unrecognized_model\] (\{[^\r\n]*\})$/.exec(detail.trim());
  if (match) {
    try {
      const event = JSON.parse(match[1]!);
      if (event && typeof event.model === "string" && event.model.length > 0 &&
          event.query_source === "generate_session_title") {
        return { kind: "info", message: "Claude SDK: aviso de generación del título de sesión (no acredita fallo de inferencia). " + detail };
      }
    } catch { /* preserve warning */ }
  }
  return { kind: "warning", message: "Claude SDK: " + detail };
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveSecurityAuditPollOutcome } from "./security-operations.js";

/**
 * Paquete 8: clasificación PURA de la respuesta del sondeo de
 * `GET /api/security-audit/runs/:runId`. La BD sigue siendo la única fuente de
 * verdad: aquí solo se interpreta lo que la API respondió.
 */
test("Paquete 8: resolveSecurityAuditPollOutcome classifies each poll response", () => {
  const preparingBody = {
    preparing: true,
    runId: "api-sondeo-1",
    message: "La auditoría está en preparación.",
  };

  // 202 con preparing:true → "preparing" (nunca error ni "no encontrada").
  assert.equal(resolveSecurityAuditPollOutcome(202, preparingBody, true), "preparing");
  // El flag preparing tiene precedencia incluso con otro código (defensivo).
  assert.equal(resolveSecurityAuditPollOutcome(404, { preparing: true }, true), "preparing");

  // 200 con el estado completo → "ready".
  assert.equal(resolveSecurityAuditPollOutcome(200, { run: { runId: "api-sondeo-1" } }, true), "ready");

  // 404 sin preparación → identificador realmente inexistente.
  assert.equal(
    resolveSecurityAuditPollOutcome(404, { error: "Auditoría no encontrada." }, true),
    "missing",
  );
  // Cualquier otro fallo sin preparing se trata como ausente (la UI muestra el
  // error una sola vez y deja de sondear).
  assert.equal(resolveSecurityAuditPollOutcome(500, { error: "boom" }, true), "missing");

  // Respuesta de otra generación (otro run seleccionado u otra petición):
  // SIEMPRE obsoleta, sin importar el cuerpo.
  assert.equal(resolveSecurityAuditPollOutcome(200, { run: { runId: "otro" } }, false), "stale");
  assert.equal(resolveSecurityAuditPollOutcome(202, preparingBody, false), "stale");
  assert.equal(resolveSecurityAuditPollOutcome(404, { error: "x" }, false), "stale");
});

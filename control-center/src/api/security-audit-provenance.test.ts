/**
 * Pruebas de `resolvePriorDiscoverer` (paquete 5): la procedencia REAL del
 * descubridor de un candidato sembrado desde el ledger de una corrida previa.
 * La resolución es PURA y NUNCA adivina: con evidencia insuficiente o ambigua
 * devuelve el motivo exacto en vez de un descubridor inventado.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolvePriorDiscoverer } from "./security-audit-orchestrator.js";

type PriorInvocation = Parameters<typeof resolvePriorDiscoverer>[0][number];

function invocation(overrides: Partial<PriorInvocation> = {}): PriorInvocation {
  return {
    instance_id: "sa-prior-1-architect-abcd1234",
    phase: 2,
    agent_id: "architect",
    engine: "opencode",
    session_id: "session-prior-hunter",
    ...overrides,
  };
}

test("resolvePriorDiscoverer: una única invocación de fase 1/2 del agente resuelve el descubridor", () => {
  assert.deepEqual(
    resolvePriorDiscoverer([invocation()], "architect"),
    {
      resolved: true,
      instanceId: "sa-prior-1-architect-abcd1234",
      engine: "opencode",
      sessionId: "session-prior-hunter",
    },
  );
  // También resuelve con motor claude y con la invocación de fase 1 (recon).
  assert.deepEqual(
    resolvePriorDiscoverer(
      [invocation({ instance_id: "sa-prior-1-reverse-efef5678", agent_id: "reverse", engine: "claude", phase: 1 })],
      "reverse",
    ),
    {
      resolved: true,
      instanceId: "sa-prior-1-reverse-efef5678",
      engine: "claude",
      sessionId: "session-prior-hunter",
    },
  );
  // Sin sesión persistida, sessionId es null (nunca una sesión inventada).
  assert.deepEqual(
    resolvePriorDiscoverer([invocation({ session_id: null })], "architect"),
    {
      resolved: true,
      instanceId: "sa-prior-1-architect-abcd1234",
      engine: "opencode",
      sessionId: null,
    },
  );
});

test("resolvePriorDiscoverer: sin invocaciones del agente es missing_prior_agent (nunca adivina)", () => {
  assert.deepEqual(resolvePriorDiscoverer([], "architect"), { resolved: false, reason: "missing_prior_agent" });
  assert.deepEqual(
    resolvePriorDiscoverer([invocation({ agent_id: "reverse" })], "architect"),
    { resolved: false, reason: "missing_prior_agent" },
  );
});

test("resolvePriorDiscoverer: dos invocaciones del mismo agente son ambiguas", () => {
  const resolution = resolvePriorDiscoverer(
    [
      invocation({ instance_id: "sa-prior-1-architect-abcd1234" }),
      invocation({ instance_id: "sa-prior-1-architect-9999ffff", phase: 1 }),
    ],
    "architect",
  );
  assert.deepEqual(resolution, { resolved: false, reason: "ambiguous_prior_invocation" });
});

test("resolvePriorDiscoverer: agente nulo es missing_prior_agent aunque haya invocaciones", () => {
  assert.deepEqual(
    resolvePriorDiscoverer([invocation()], null),
    { resolved: false, reason: "missing_prior_agent" },
  );
});

test("resolvePriorDiscoverer: ignora fase 3+, otros agentes y motores no reales", () => {
  const resolution = resolvePriorDiscoverer(
    [
      // Fase 3 del mismo agente: un verificador jamás es el descubridor.
      invocation({ instance_id: "sa-prior-1-architect-fase3", phase: 3 }),
      // Fase 2 de otro agente.
      invocation({ instance_id: "sa-prior-1-reverse-fase2", agent_id: "reverse" }),
      // Mismo agente con motor ausente o no real: sin motor verificable no hay
      // descubridor, y la ambigüedad con otra invocación válida no se resuelve.
      invocation({ instance_id: "sa-prior-1-architect-sin-motor", engine: null, phase: 1 }),
      invocation({ instance_id: "sa-prior-1-architect-fantasma", engine: "gemini", phase: 1 }),
    ],
    "architect",
  );
  assert.equal(resolution.resolved, false, "con evidencia inservible no se inventa descubridor");
  if (!resolution.resolved) assert.equal(resolution.reason, "missing_prior_agent");

  // Una sola válida entre ruido inservible SÍ resuelve (el ruido no cuenta
  // como segunda invocación del agente).
  const mixed = resolvePriorDiscoverer(
    [
      invocation(), // la única invocación válida de fase 1/2 del arquitecto
      invocation({ instance_id: "sa-prior-1-architect-fase3", phase: 3 }),
      invocation({ instance_id: "sa-prior-1-reverse-fase2", agent_id: "reverse" }),
      invocation({ instance_id: "sa-prior-1-architect-sin-motor", engine: null, phase: 1 }),
    ],
    "architect",
  );
  assert.deepEqual(mixed, {
    resolved: true,
    instanceId: "sa-prior-1-architect-abcd1234",
    engine: "opencode",
    sessionId: "session-prior-hunter",
  });
});

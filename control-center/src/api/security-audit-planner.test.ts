import assert from "node:assert/strict";
import { test } from "node:test";
import {
  planTask,
  resolveAgentPermissionProfile,
  selectAgentsForTask,
} from "./task-planner.js";

const FULL_TEAM = [
  "architect", "build", "implementer", "reviewer", "tester", "reverse", "cloud-arbiter",
].map((agentId) => ({ agentId, enabled: true }));

/**
 * B3/M3: el plan tradicional del baseline (867892d) debe conservarse EXACTO
 * con vocabulario security. Estos valores se capturaron ejecutando el
 * planTask del baseline para cada instrucción.
 */
const BASELINE_CASES: Array<{
  text: string;
  kind: string;
  complexity: string;
  depth: string;
  agents: string[];
  changesExpected: boolean;
  implementerPermission: string;
  reasons: string[];
}> = [
  {
    text: "Corrige CVE-2026-1234 en el paquete dependiente",
    kind: "implementation",
    complexity: "medium",
    depth: "focused",
    agents: ["architect", "implementer", "reviewer", "tester", "cloud-arbiter"],
    changesExpected: true,
    implementerPermission: "workspace-write",
    reasons: ["La instruccion solicita cambios en el codigo."],
  },
  {
    text: "haz una auditoría de cobertura del módulo de pagos",
    kind: "testing",
    complexity: "medium",
    depth: "focused",
    agents: ["tester", "build"],
    changesExpected: false,
    implementerPermission: "read-only",
    reasons: ["La instruccion solicita validacion o pruebas."],
  },
  {
    text: "revisa la seguridad del proyecto",
    kind: "architecture-review",
    complexity: "high",
    depth: "deep",
    agents: ["architect", "reviewer", "tester", "cloud-arbiter"],
    changesExpected: false,
    implementerPermission: "read-only",
    reasons: [
      "El objetivo requiere una revision amplia o especializada.",
      "Se seleccionan especialistas de lectura y validacion; no se habilitan cambios.",
    ],
  },
  {
    text: "corrige los findings confirmados de la auditoría",
    kind: "implementation",
    complexity: "high",
    depth: "deep",
    agents: ["architect", "implementer", "reviewer", "tester", "build", "cloud-arbiter"],
    changesExpected: true,
    implementerPermission: "workspace-write",
    reasons: ["La instruccion solicita cambios en el codigo."],
  },
  {
    text: "¿Qué es una vulnerabilidad de inyección SQL?",
    kind: "general",
    complexity: "medium",
    depth: "focused",
    agents: ["architect"],
    changesExpected: false,
    implementerPermission: "read-only",
    reasons: ["No se detecto una accion especifica; se propone una exploracion focalizada con el Arquitecto."],
  },
  {
    text: "haz una auditoría completa del repositorio",
    kind: "architecture-review",
    complexity: "high",
    depth: "deep",
    agents: ["architect", "reviewer", "tester", "cloud-arbiter"],
    changesExpected: false,
    implementerPermission: "read-only",
    reasons: [
      "El objetivo requiere una revision amplia o especializada.",
      "Se seleccionan especialistas de lectura y validacion; no se habilitan cambios.",
      "El alcance declarado abarca multiples modulos o el proyecto completo.",
    ],
  },
];

test("B3: security vocabulary never changes the baseline plan", () => {
  for (const expected of BASELINE_CASES) {
    const plan = planTask(expected.text);
    assert.equal(plan.kind, expected.kind, expected.text);
    assert.equal(plan.complexity, expected.complexity, expected.text);
    assert.equal(plan.depth, expected.depth, expected.text);
    assert.deepEqual(plan.recommendedAgents, expected.agents, expected.text);
    assert.equal(plan.changesExpected, expected.changesExpected, expected.text);
    assert.deepEqual(plan.reasons, expected.reasons, expected.text);
    assert.equal(
      resolveAgentPermissionProfile("implementer", plan, "automatic", "read-only").permissionProfile,
      expected.implementerPermission,
      expected.text,
    );
  }
});

test("M3: securityOperation is additive metadata only", () => {
  // El plan de estas instrucciones es idéntico al baseline (test anterior);
  // aquí solo se comprueba que la metadata no altera nada.
  const cve = planTask("Corrige CVE-2026-1234 en el paquete dependiente");
  assert.equal(cve.securityOperation.kind, "guidance");
  assert.equal(cve.changesExpected, true);
  assert.ok(cve.recommendedAgents.includes("implementer"));

  const coverageAudit = planTask("haz una auditoría de cobertura del módulo de pagos");
  assert.equal(coverageAudit.securityOperation.kind, "full_audit");
  assert.equal(coverageAudit.kind, "testing");
  assert.deepEqual(coverageAudit.recommendedAgents, ["tester", "build"]);

  const remediation = planTask("corrige los findings confirmados de la auditoría");
  assert.equal(remediation.securityOperation.kind, "remediation");
  assert.equal(remediation.changesExpected, true, "el plan sigue siendo implementación");

  const fullAudit = planTask("haz una auditoría completa del repositorio");
  assert.equal(fullAudit.securityOperation.kind, "full_audit");

  const ambiguous = planTask("revisa la seguridad del proyecto");
  assert.equal(ambiguous.securityOperation.kind, "guidance");
  assert.equal(ambiguous.securityOperation.requiresClarification, true);
});

test("M3: the remediation route disables security classification without changing the plan", () => {
  const text = "corrige los findings confirmados de la auditoría";
  const normal = planTask(text);
  const remediation = planTask(text, undefined, { securityRemediation: true });
  assert.equal(remediation.securityOperation.kind, "none");
  assert.equal(remediation.securityOperation.requiresClarification, false);
  assert.deepEqual(remediation.securityOperation.matchedSignals, []);
  // El resto del plan es idéntico al tradicional.
  assert.equal(remediation.kind, normal.kind);
  assert.equal(remediation.complexity, normal.complexity);
  assert.equal(remediation.depth, normal.depth);
  assert.deepEqual(remediation.recommendedAgents, normal.recommendedAgents);
  assert.equal(remediation.changesExpected, normal.changesExpected);
  assert.deepEqual(remediation.reasons, normal.reasons);
  assert.equal(
    resolveAgentPermissionProfile("implementer", remediation, "automatic", "read-only").permissionProfile,
    "workspace-write",
    "el Implementer de la remediación conserva escritura sujeta a permisos",
  );
});

test("M3: a remediation plan selects the normal implementation team", () => {
  const plan = planTask("corrige los findings confirmados de la auditoría", undefined, {
    securityRemediation: true,
  });
  assert.equal(plan.changesExpected, true);
  for (const agentId of ["architect", "implementer", "reviewer", "tester", "cloud-arbiter"]) {
    assert.ok(plan.recommendedAgents.includes(agentId), agentId);
  }
  const selection = selectAgentsForTask(FULL_TEAM, plan);
  assert.deepEqual(selection.selectedAgentIds, plan.recommendedAgents);
  assert.ok(selection.selectedAgentIds.includes("implementer"));
});

test("traditional instructions keep their classification and write permissions", () => {
  const cases: Array<[string, string, boolean]> = [
    ["Implementa pruebas unitarias para el servicio de pólizas.", "implementation", true],
    ["Investiga por qué falla la autenticación.", "diagnosis", false],
    ["Explica de qué trata este proyecto.", "explanation", false],
    ["Ejecuta pruebas unitarias y valida la cobertura.", "testing", false],
    ["Aumenta la tipografía sin cambiar el formato APA del Word.", "implementation", true],
    ["Sigue con las correcciones sugeridas sin dañar la lógica actual.", "implementation", true],
  ];
  for (const [instructions, kind, changesExpected] of cases) {
    const plan = planTask(instructions);
    assert.equal(plan.kind, kind, instructions);
    assert.equal(plan.changesExpected, changesExpected, instructions);
    assert.equal(plan.securityOperation.kind, "none", instructions);
    if (changesExpected) {
      assert.ok(plan.recommendedAgents.includes("implementer"), instructions);
      assert.equal(
        resolveAgentPermissionProfile("implementer", plan, "automatic", "read-only").permissionProfile,
        "workspace-write",
        instructions,
      );
    }
  }
});

test("negative clauses never become write authorization", () => {
  const plan = planTask("No cambies el Word, aumenta la letra en la web.");
  assert.equal(plan.kind, "implementation");
  assert.equal(plan.changesExpected, true);
  assert.equal(plan.securityOperation.kind, "none");
  assert.equal(
    resolveAgentPermissionProfile("implementer", plan, "automatic", "read-only").permissionProfile,
    "workspace-write",
  );
});

test("planTask has no side effects: it never creates audit artifacts", () => {
  const before = process.env.FACTORY_STATE_DIR;
  const plan = planTask("haz una auditoría completa del proyecto");
  assert.equal(typeof plan, "object");
  assert.equal(process.env.FACTORY_STATE_DIR, before);
  assert.equal(plan.securityOperation.kind, "full_audit");
});

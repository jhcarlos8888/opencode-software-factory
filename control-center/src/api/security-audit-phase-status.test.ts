import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computeSecurityAuditPhaseStates,
  type SecurityAuditPhaseStatusInput,
} from "./security-audit-phase-status.js";

function input(overrides: Partial<SecurityAuditPhaseStatusInput> = {}): SecurityAuditPhaseStatusInput {
  return {
    profile: "standard",
    phasesComplete: [1, 2, 3, 4, 5, 6],
    unvalidatedCandidates: [],
    pendingUnits: [],
    incompleteReasons: [],
    consolidatedUnits: 0,
    ...overrides,
  };
}

test("a full standard run reports every phase completed without reasons", () => {
  const states = computeSecurityAuditPhaseStates(input());
  assert.equal(states.length, 6);
  for (const phase of states) {
    assert.equal(phase.state, "completed", `fase ${phase.phase}: ${phase.reason ?? ""}`);
    assert.equal(phase.reason, null);
  }
  assert.deepEqual(states.map((phase) => phase.phase), [1, 2, 3, 4, 5, 6]);
});

test("quick profile reports phase 5 as not_applicable even when its checkpoint exists", () => {
  const states = computeSecurityAuditPhaseStates(input({ profile: "quick" }));
  const phase5 = states.find((phase) => phase.phase === 5);
  assert.equal(phase5?.state, "not_applicable");
  assert.match(phase5?.reason ?? "", /fusionada/);
  // El resto de fases siguen completas.
  for (const phase of states.filter((entry) => entry.phase !== 5)) {
    assert.equal(phase.state, "completed");
  }
});

test("six unvalidated candidates mark phase 3 partial, and budget exhaustion marks it blocked", () => {
  const fingerprints = ["fp-1", "fp-2", "fp-3", "fp-4", "fp-5", "fp-6"];
  const partial = computeSecurityAuditPhaseStates(input({
    unvalidatedCandidates: fingerprints,
    incompleteReasons: ["critic_budget_exhausted"],
  }));
  const partialPhase3 = partial.find((phase) => phase.phase === 3);
  assert.equal(partialPhase3?.state, "partial");
  assert.match(partialPhase3?.reason ?? "", /6 candidato\(s\)/);
  assert.equal((partialPhase3?.reason ?? "").includes("presupuesto"), false);

  const blocked = computeSecurityAuditPhaseStates(input({
    unvalidatedCandidates: fingerprints,
    incompleteReasons: ["validation_budget_exhausted", "orchestrator_failed"],
  }));
  const blockedPhase3 = blocked.find((phase) => phase.phase === 3);
  assert.equal(blockedPhase3?.state, "blocked");
  assert.match(blockedPhase3?.reason ?? "", /6 candidato\(s\) sin validar por presupuesto/);
});

test("pending coverage units mark phase 2 partial with a clear reason", () => {
  const states = computeSecurityAuditPhaseStates(input({
    phasesComplete: [1, 2, 3, 4, 5, 6],
    pendingUnits: ["u-planned-1", "u-planned-2", "u-planned-3"],
  }));
  const phase2 = states.find((phase) => phase.phase === 2);
  assert.equal(phase2?.state, "partial");
  assert.match(phase2?.reason ?? "", /3 unidad\(es\) de cobertura/);
  assert.equal((phase2?.reason ?? "").toLowerCase().includes("completada"), false);
});

// Defecto 3: con contadores separados, los candidatos pendientes de fase 3
// NUNCA marcan la fase 2 como parcial (la caza terminó).
test("finished hunting with pending candidates: phase 2 completed, phase 3 blocked", () => {
  const fingerprints = ["fp-1", "fp-2", "fp-3", "fp-4", "fp-5", "fp-6"];
  const states = computeSecurityAuditPhaseStates(input({
    pendingUnits: ["unit-candidato-1", "unit-candidato-2"],
    pendingCoverageUnits: 0,
    pendingCandidateUnits: 2,
    unvalidatedCandidates: fingerprints,
    incompleteReasons: ["validation_budget_exhausted", "orchestrator_failed"],
  }));
  const phase2 = states.find((phase) => phase.phase === 2);
  assert.equal(phase2?.state, "completed", phase2?.reason ?? "");
  assert.equal(phase2?.reason, null);
  const phase3 = states.find((phase) => phase.phase === 3);
  assert.equal(phase3?.state, "blocked");
  assert.match(phase3?.reason ?? "", /6 candidato\(s\) sin validar por presupuesto/);
});

// Defecto 3: unidades `planned` (cobertura sin cazar) marcan la fase 2 parcial
// y NO producen hueco de fase 3 si no hay candidatos.
test("planned coverage units keep phase 2 partial and phase 3 completed", () => {
  const states = computeSecurityAuditPhaseStates(input({
    pendingCoverageUnits: 2,
    pendingCandidateUnits: 0,
  }));
  const phase2 = states.find((phase) => phase.phase === 2);
  assert.equal(phase2?.state, "partial");
  assert.match(phase2?.reason ?? "", /2 unidad\(es\) de cobertura/);
  const phase3 = states.find((phase) => phase.phase === 3);
  assert.equal(phase3?.state, "completed", phase3?.reason ?? "");
});

test("phases without a checkpoint stay pending even with official reasons", () => {
  const states = computeSecurityAuditPhaseStates(input({
    phasesComplete: [1, 2],
    unvalidatedCandidates: ["fp-1"],
  }));
  assert.deepEqual(
    states.filter((phase) => phase.state === "pending").map((phase) => phase.phase),
    [3, 4, 5, 6],
  );
  for (const phase of states.filter((phase) => phase.state === "pending")) {
    assert.match(phase.reason ?? "", /no completada/);
  }
  assert.equal(states.find((phase) => phase.phase === 1)?.state, "completed");
});

test("a validator failure blocks phases 4 and 6 even with checkpoints complete", () => {
  const states = computeSecurityAuditPhaseStates(input({
    incompleteReasons: ["validator_failed"],
  }));
  assert.equal(states.find((phase) => phase.phase === 4)?.state, "blocked");
  assert.equal(states.find((phase) => phase.phase === 6)?.state, "blocked");
  assert.equal(states.find((phase) => phase.phase === 1)?.state, "completed");
  assert.equal(states.find((phase) => phase.phase === 2)?.state, "completed");
});

test("consolidated units appear in the phase 3 reason without changing its state", () => {
  const states = computeSecurityAuditPhaseStates(input({
    unvalidatedCandidates: ["fp-1"],
    consolidatedUnits: 3,
  }));
  const phase3 = states.find((phase) => phase.phase === 3);
  assert.equal(phase3?.state, "partial");
  assert.match(phase3?.reason ?? "", /3 unidad\(es\) consolidadas/);
});

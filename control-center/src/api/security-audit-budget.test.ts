import assert from "node:assert/strict";
import test from "node:test";
import {
  availableSecurityAuditParallelism,
  cancelSecurityAuditBudget,
  createSecurityAuditBudget,
  criticReserveFor,
  freeSecurityAuditUnits,
  minimumSecurityAuditBudget,
  planSecurityAuditHuntWave,
  resumeSecurityAuditBudget,
  securityAuditBudgetEvidence,
  securityAuditBudgetOverLimit,
  spendSecurityAuditCritic,
  spendSecurityAuditRecon,
  spendSecurityAuditVerifier,
  refundSecurityAuditHunters,
  tickSecurityAuditBudget,
  SecurityAuditBudgetConfigError,
} from "./security-audit-budget.js";
import { verificationStrategyFor } from "./security-audit-contracts.js";

function ledgerFor(profile: "quick" | "standard" | "deep", maxInvocations: number, pendingUnits = 0) {
  const created = createSecurityAuditBudget({
    profile,
    maxInvocations,
    maxConcurrency: 2,
    maxDurationMs: 60_000,
    pendingUnits,
  });
  assert.equal(created.ok, true, "el presupuesto mínimo debe ser aceptado");
  if (!created.ok) throw new Error("unreachable");
  return created.ledger;
}

test("official minimums are 6 for quick and 7 for standard/deep", () => {
  assert.equal(criticReserveFor("quick"), 1);
  assert.equal(criticReserveFor("standard"), 2);
  assert.equal(criticReserveFor("deep"), 2);
  assert.equal(minimumSecurityAuditBudget("quick"), 6);
  assert.equal(minimumSecurityAuditBudget("standard"), 7);
  assert.equal(minimumSecurityAuditBudget("deep"), 7);

  for (const profile of ["standard", "deep"] as const) {
    assert.equal(createSecurityAuditBudget({
      profile, maxInvocations: 6, maxConcurrency: 1, maxDurationMs: 1000,
    }).ok, false);
    const accepted = createSecurityAuditBudget({
      profile, maxInvocations: 7, maxConcurrency: 1, maxDurationMs: 1000,
    });
    assert.equal(accepted.ok, true, `${profile} debe aceptar 7`);
  }
  const quickSix = createSecurityAuditBudget({
    profile: "quick", maxInvocations: 6, maxConcurrency: 1, maxDurationMs: 1000,
  });
  assert.equal(quickSix.ok, true);
  const tooSmall = createSecurityAuditBudget({
    profile: "quick", maxInvocations: 5, maxConcurrency: 1, maxDurationMs: 1000,
  });
  assert.deepEqual(tooSmall, {
    ok: false,
    reason: "budget_cannot_fund_reconnaissance_and_reserves",
  });
});

test("reserve gate rejects budgets that cannot fund recon and reserves", () => {
  // 4 recon + 2 críticos + 6 verificadores esperados no caben en 10.
  const cannotReserve = createSecurityAuditBudget({
    profile: "standard",
    maxInvocations: 10,
    maxConcurrency: 1,
    maxDurationMs: 1000,
    expectedCandidates: 3,
  });
  assert.deepEqual(cannotReserve, {
    ok: false,
    reason: "budget_cannot_fund_reconnaissance_and_reserves",
  });

  // Con duda se reserva el 30% del balance tras los críticos.
  const inDoubt = createSecurityAuditBudget({
    profile: "standard",
    maxInvocations: 20,
    maxConcurrency: 1,
    maxDurationMs: 1000,
    inDoubt: true,
  });
  assert.equal(inDoubt.ok, true);
  if (inDoubt.ok) {
    // balance = 20 - 4 - 2 = 14 → ceil(14 * 0.3) = 5
    assert.deepEqual(inDoubt.ledger.reserved, { recon: 4, critics: 2, validation: 5 });
    assert.equal(freeSecurityAuditUnits(inDoubt.ledger), 9);
  }
});

test("reserves exist before any hunter and evidence is inspectable", () => {
  const ledger = ledgerFor("standard", 20, 4);
  assert.deepEqual(ledger.reserved, { recon: 4, critics: 2, validation: 1 });
  assert.deepEqual(ledger.spent, { recon: 0, hunters: 0, critics: 0, verifiers: 0 });
  assert.equal(ledger.pendingUnits, 4);
  assert.equal(securityAuditBudgetOverLimit(ledger), false);

  const evidence = securityAuditBudgetEvidence(ledger);
  assert.equal(evidence.free, 13);
  assert.equal(evidence.pendingUnits, 4);
  assert.equal(evidence.wavesStarted, 0);
  assert.equal(evidence.concurrency.hunters, 2);
  assert.ok(evidence.concurrency.recon <= evidence.maxConcurrency);
  assert.deepEqual(evidence.deferredUnits, []);
});

test("hunters cannot start before the four baseline reconnaissance calls", () => {
  const ledger = ledgerFor("standard", 20);
  const blocked = planSecurityAuditHuntWave(ledger, ["unit-1", "unit-2"]);
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.reason, "reconnaissance_not_completed");

  const afterRecon = spendSecurityAuditRecon(ledger, 4);
  assert.equal(afterRecon.ok, true);
  if (afterRecon.ok) {
    assert.deepEqual(afterRecon.ledger.reserved.recon, 0);
    assert.equal(afterRecon.ledger.spent.recon, 4);
    const wave = planSecurityAuditHuntWave(
      afterRecon.ledger,
      ["unit-1", "unit-2", "unit-3", "unit-4", "unit-5"],
    );
    assert.equal(wave.ok, true);
    if (wave.ok) {
      // free = 20 - 4 - 7 = 9 → solo 9 unidades caben en la ola.
      assert.equal(wave.launched, 5);
      assert.equal(wave.wave, 1);
      assert.equal(wave.deferred.length, 0);
      // Las reservas de críticos y validación siguen intactas.
      assert.deepEqual(wave.ledger.reserved, { recon: 0, critics: 2, validation: 1 });
      assert.equal(securityAuditBudgetOverLimit(wave.ledger), false);
      assert.equal(wave.ledger.pendingUnits, 0);
    }
  }
});

test("quick runs exactly one hunter wave with one reserved critic", () => {
  const ledger = ledgerFor("quick", 12);
  assert.equal(criticReserveFor("quick"), 1);
  assert.deepEqual(ledger.reserved, { recon: 4, critics: 1, validation: 1 });

  const afterRecon = spendSecurityAuditRecon(ledger, 4);
  assert.equal(afterRecon.ok, true);
  if (!afterRecon.ok) throw new Error("recon debía gastarse");

  const first = planSecurityAuditHuntWave(afterRecon.ledger, ["a", "b", "c"]);
  assert.equal(first.ok, true);
  if (first.ok) {
    assert.equal(first.wave, 1);
    assert.equal(first.launched, 3);
    assert.deepEqual(first.ledger.reserved, { recon: 0, critics: 1, validation: 1 });
    const second = planSecurityAuditHuntWave(first.ledger, ["d"]);
    assert.equal(second.ok, false);
    if (!second.ok) {
      assert.equal(second.reason, "quick_profile_single_wave");
      assert.deepEqual(second.unitIds, ["d"]);
    }
  }
});

test("standard/deep reserve a new post-wave critic before every later wave", () => {
  const ledger = ledgerFor("standard", 10);
  const afterRecon = spendSecurityAuditRecon(ledger, 4);
  assert.equal(afterRecon.ok, true);
  if (!afterRecon.ok) throw new Error("recon debía gastarse");

  const first = planSecurityAuditHuntWave(afterRecon.ledger, ["u1", "u2", "u3"]);
  assert.equal(first.ok, true);
  if (!first.ok) throw new Error("ola 1 debía lanzarse");
  assert.equal(first.launched, 3);
  assert.deepEqual(first.ledger.reserved, { recon: 0, critics: 2, validation: 1 });

  const critic = spendSecurityAuditCritic(first.ledger, 1);
  assert.equal(critic.ok, true);
  if (!critic.ok) throw new Error("crítico post-ola disponible");
  // Queda el crítico final limpio reservado.
  assert.equal(critic.ledger.reserved.critics, 1);

  // free = 10 - (4+3+1) - (1+1) = 0 → no hay saldo para reservar el crítico
  // de la ola 2 y las unidades quedan diferidas con el motivo oficial.
  const second = planSecurityAuditHuntWave(critic.ledger, ["u4", "u5"]);
  assert.equal(second.ok, false);
  if (!second.ok) {
    assert.equal(second.reason, "budget_cannot_reserve_critics_and_validation");
    assert.deepEqual(second.unitIds, ["u4", "u5"]);
  }
  assert.equal(securityAuditBudgetOverLimit(critic.ledger), false);
});

test("hunter allowance spend defers the rest instead of exceeding the max", () => {
  const ledger = ledgerFor("standard", 10, 6);
  const afterRecon = spendSecurityAuditRecon(ledger, 4);
  assert.equal(afterRecon.ok, true);
  if (!afterRecon.ok) throw new Error("recon debía gastarse");

  const wave = planSecurityAuditHuntWave(afterRecon.ledger, ["u1", "u2", "u3", "u4", "u5", "u6"]);
  assert.equal(wave.ok, true);
  if (wave.ok) {
    assert.equal(wave.launched, 3);
    assert.deepEqual(
      wave.deferred.map((entry) => [entry.unitId, entry.reason]),
      [
        ["u4", "hunt_budget_exhausted"],
        ["u5", "hunt_budget_exhausted"],
        ["u6", "hunt_budget_exhausted"],
      ],
    );
    assert.equal(wave.ledger.spent.hunters, 3);
    assert.equal(wave.ledger.pendingUnits, 0);
    assert.equal(wave.ledger.deferredUnits.length, 3);
    assert.equal(securityAuditBudgetOverLimit(wave.ledger), false);
    // free = 10 - 4 - 3 - (2 + 1) = 0
    assert.equal(freeSecurityAuditUnits(wave.ledger), 0);
    // En standard/deep la ola 2 primero debe reservar su crítico post-ola.
    const extraHunters = planSecurityAuditHuntWave(wave.ledger, ["u7"]);
    assert.equal(extraHunters.ok, false);
    if (!extraHunters.ok) {
      assert.equal(extraHunters.reason, "budget_cannot_reserve_critics_and_validation");
      assert.deepEqual(extraHunters.unitIds, ["u7"]);
    }
  }
});

test("a first wave with no hunting allowance launches nothing and defers units", () => {
  // Mínimo oficial: todo el presupuesto queda reservado para recon, críticos
  // y verificación; la caza no puede gastar nada y las unidades se difieren.
  const ledger = ledgerFor("standard", 7, 2);
  const afterRecon = spendSecurityAuditRecon(ledger, 4);
  assert.equal(afterRecon.ok, true);
  if (!afterRecon.ok) throw new Error("recon debía gastarse");
  const wave = planSecurityAuditHuntWave(afterRecon.ledger, ["u1", "u2"]);
  assert.equal(wave.ok, true);
  if (wave.ok) {
    assert.equal(wave.launched, 0);
    assert.deepEqual(
      wave.deferred.map((entry) => [entry.unitId, entry.reason]),
      [
        ["u1", "hunt_budget_exhausted"],
        ["u2", "hunt_budget_exhausted"],
      ],
    );
    assert.deepEqual(wave.ledger.reserved, { recon: 0, critics: 2, validation: 1 });
    assert.equal(securityAuditBudgetOverLimit(wave.ledger), false);
  }
});

test("critic and validation exhaustion keep the official incomplete reasons", () => {
  const quick = ledgerFor("quick", 6);
  const recon = spendSecurityAuditRecon(quick, 4);
  assert.equal(recon.ok, true);
  if (!recon.ok) throw new Error("recon debía gastarse");

  const firstCritic = spendSecurityAuditCritic(recon.ledger, 1);
  assert.equal(firstCritic.ok, true);
  if (firstCritic.ok) {
    assert.equal(firstCritic.ledger.reserved.critics, 0);
    const secondCritic = spendSecurityAuditCritic(firstCritic.ledger, 1);
    assert.deepEqual(secondCritic, { ok: false, reason: "critic_budget_exhausted" });
  }

  const standard = ledgerFor("standard", 7);
  const recon2 = spendSecurityAuditRecon(standard, 4);
  assert.equal(recon2.ok, true);
  if (!recon2.ok) throw new Error("recon debía gastarse");
  const verifier = spendSecurityAuditVerifier(recon2.ledger, {
    fingerprints: ["src-handler-missing-check"],
  });
  assert.equal(verifier.ok, true);
  if (verifier.ok) {
    const exhausted = spendSecurityAuditVerifier(verifier.ledger, {
      fingerprints: ["src-parser-size-hypothesis"],
    });
    assert.equal(exhausted.ok, false);
    if (!exhausted.ok) {
      assert.equal(exhausted.reason, "validation_budget_exhausted");
      assert.deepEqual(exhausted.unvalidatedFingerprints, ["src-parser-size-hypothesis"]);
    }
    assert.equal(securityAuditBudgetOverLimit(verifier.ledger), false);
  }
});

test("concurrency is an integer >= 1 and never exceeds the remaining budget", () => {
  assert.throws(
    () => createSecurityAuditBudget({
      profile: "standard", maxInvocations: 7, maxConcurrency: 0, maxDurationMs: 1000,
    }),
    SecurityAuditBudgetConfigError,
  );
  assert.throws(
    () => createSecurityAuditBudget({
      profile: "standard", maxInvocations: 7, maxConcurrency: 1.5, maxDurationMs: 1000,
    }),
    SecurityAuditBudgetConfigError,
  );

  const ledger = ledgerFor("standard", 7);
  assert.equal(availableSecurityAuditParallelism(ledger, "recon"), 2);
  assert.equal(availableSecurityAuditParallelism(ledger, "hunters"), 0);
  const afterRecon = spendSecurityAuditRecon(ledger, 4);
  assert.equal(afterRecon.ok, true);
  if (afterRecon.ok) {
    assert.equal(availableSecurityAuditParallelism(afterRecon.ledger, "recon"), 0);
    assert.equal(availableSecurityAuditParallelism(afterRecon.ledger, "hunters"), 0);
    assert.equal(availableSecurityAuditParallelism(afterRecon.ledger, "critics"), 2);
    // La reserva de validación del mínimo oficial es de un verificador.
    assert.equal(availableSecurityAuditParallelism(afterRecon.ledger, "verifiers"), 1);
  }

  const wide = ledgerFor("deep", 40);
  const wideEvidence = securityAuditBudgetEvidence(wide);
  assert.equal(wideEvidence.concurrency.recon, 2);
  assert.ok(wideEvidence.concurrency.recon <= wide.maxConcurrency);
});

test("cancel blocks spending and resume restores it; duration expiry is final", () => {
  const ledger = ledgerFor("standard", 20);
  const cancelled = cancelSecurityAuditBudget(ledger);
  assert.equal(cancelled.state, "cancelled");
  assert.deepEqual(spendSecurityAuditRecon(cancelled, 1), { ok: false, reason: "run_cancelled" });
  assert.equal(availableSecurityAuditParallelism(cancelled, "recon"), 0);

  const resumed = resumeSecurityAuditBudget(cancelled);
  assert.equal(resumed.ok, true);
  if (resumed.ok) {
    assert.equal(resumed.ledger.state, "active");
    assert.equal(spendSecurityAuditRecon(resumed.ledger, 1).ok, true);
  }

  const expired = tickSecurityAuditBudget(ledger, 60_001);
  assert.equal(expired.state, "expired");
  assert.deepEqual(spendSecurityAuditRecon(expired, 1), { ok: false, reason: "max_duration_exhausted" });
  assert.deepEqual(resumeSecurityAuditBudget(expired), {
    ok: false,
    reason: "max_duration_exhausted",
  });
  assert.equal(tickSecurityAuditBudget(ledger, 60_000).state, "active");
  assert.throws(() => tickSecurityAuditBudget(ledger, -1), SecurityAuditBudgetConfigError);
});

test("an over-limit ledger is detected as such", () => {
  const ledger = ledgerFor("standard", 7);
  assert.equal(securityAuditBudgetOverLimit(ledger), false);
  const tampered = {
    ...ledger,
    spent: { recon: 4, hunters: 5, critics: 2, verifiers: 1 },
  };
  assert.equal(securityAuditBudgetOverLimit(tampered), true);
  const unlimited = { ...ledger, maxInvocations: null };
  assert.equal(securityAuditBudgetOverLimit(unlimited), false);
});

test("refundSecurityAuditHunters returns unlaunched wave spend without ever exceeding the cap", () => {
  const ledger = ledgerFor("quick", 8);
  const afterRecon = spendSecurityAuditRecon(ledger, 4);
  assert.equal(afterRecon.ok, true);
  if (!afterRecon.ok) throw new Error("unreachable");
  // Ola con 2 hunters reservados (gate atómico) y luego una cancelada.
  const wave = planSecurityAuditHuntWave(afterRecon.ledger, ["u-1", "u-2"]);
  assert.equal(wave.ok, true);
  if (!wave.ok) throw new Error("unreachable");
  assert.equal(wave.launched, 2);
  assert.equal(wave.ledger.spent.hunters, 2);

  // Devolver la unidad que nunca se invocó (vencimiento entre invocaciones).
  const refunded = refundSecurityAuditHunters(wave.ledger, 1);
  assert.equal(refunded.spent.hunters, 1);
  assert.equal(securityAuditBudgetOverLimit(refunded), false);

  // Corrección pura: el ledger original no muta y devolver de más queda a 0.
  assert.equal(wave.ledger.spent.hunters, 2);
  assert.equal(refundSecurityAuditHunters(wave.ledger, 99).spent.hunters, 0);
  assert.equal(refundSecurityAuditHunters(wave.ledger, 0), wave.ledger);
  assert.throws(() => refundSecurityAuditHunters(wave.ledger, -1), SecurityAuditBudgetConfigError);
});

test("verification strategy separates phases 3 and 5 except for quick", () => {
  const quick = verificationStrategyFor("quick");
  assert.equal(quick.separatePhase3AndPhase5, false);
  assert.equal(quick.hunterWaveLimit, 1);
  assert.equal(quick.finalRecordVerification, "same-fresh-verifier-as-candidate-validation");

  for (const profile of ["standard", "deep"] as const) {
    const strategy = verificationStrategyFor(profile);
    assert.equal(strategy.separatePhase3AndPhase5, true, profile);
    assert.equal(strategy.hunterWaveLimit, null, profile);
    assert.equal(strategy.finalRecordVerification, "fresh-agent-per-candidate", profile);
    assert.equal(strategy.candidateValidation, "fresh-agent-per-candidate", profile);
  }
});

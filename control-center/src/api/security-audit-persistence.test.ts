import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { SecurityAuditIncompleteReason } from "./security-audit-contracts.js";
import {
  createSecurityAuditRemediation,
  createSecurityAuditRun,
  finishSecurityAuditInvocation,
  getSecurityAuditCheckpoint,
  getSecurityAuditRun,
  initializeSecurityAuditSchema,
  isSecurityAuditCancelRequested,
  listSecurityAuditFindings,
  listSecurityAuditFindingsHistory,
  listSecurityAuditRetiredFingerprints,
  listSecurityAuditInvocations,
  listSecurityAuditRemediations,
  listSecurityAuditUnits,
  loadSecurityAuditWorkState,
  planSecurityAuditResume,
  reconcileSecurityAuditFindingsProjection,
  reconcileSecurityAuditRun,
  reconcileSecurityAuditUnits,
  recordSecurityAuditCheckpoint,
  recordSecurityAuditCrossEngineEvidence,
  recordSecurityAuditInvocation,
  getSecurityAuditInvocation,
  requestSecurityAuditCancel,
  saveSecurityAuditWorkState,
  setSecurityAuditPhase,
  setSecurityAuditValidators,
  transitionSecurityAuditRemediation,
  updateSecurityAuditBudget,
  updateSecurityAuditRunStatus,
  upsertSecurityAuditFinding,
  upsertSecurityAuditUnits,
} from "./security-audit-persistence.js";

const isolatedDir = mkdtempSync(join(tmpdir(), "factory-security-audit-persistence-"));
const dbPath = join(isolatedDir, "audit.sqlite");
const db = new DatabaseSync(dbPath);

after(() => {
  db.close();
  rmSync(isolatedDir, { recursive: true, force: true });
});

function newRun(runId: string) {
  return createSecurityAuditRun(db, {
    runId,
    projectPath: "/srv/example",
    sourceRef: "abc123",
    sourceDirty: false,
    profile: "standard",
    intent: "full_audit",
    scope: { kind: "project" },
    outputDir: join(isolatedDir, "output", runId),
  });
}

test("schema initialization is idempotent on a pre-existing database", () => {
  db.exec("CREATE TABLE legacy_notes (id INTEGER PRIMARY KEY, note TEXT NOT NULL)");
  db.prepare("INSERT INTO legacy_notes (id, note) VALUES (1, 'previo')").run();
  // Base preexistente: el esquema real de Control Center incluye execution_runs.
  db.exec(`CREATE TABLE IF NOT EXISTS execution_runs (
    id TEXT PRIMARY KEY,
    project_path TEXT NOT NULL,
    instructions TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    finished_at TEXT,
    summary_json TEXT
  )`);

  initializeSecurityAuditSchema(db);
  initializeSecurityAuditSchema(db);

  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'security_audit%'",
    )
    .all() as unknown as Array<{ name: string }>;
  const names = tables.map((row) => row.name).sort();
  assert.deepEqual(names, [
    "security_audit_checkpoints",
    "security_audit_findings",
    "security_audit_findings_history",
    "security_audit_focused_attempts",
    "security_audit_focused_runs",
    "security_audit_invocations",
    "security_audit_remediations",
    "security_audit_runs",
    "security_audit_units",
    "security_audit_usage",
    "security_audit_work_state",
  ]);

  const legacy = db.prepare("SELECT note FROM legacy_notes WHERE id = 1").get() as {
    note: string;
  };
  assert.equal(legacy.note, "previo");

  const run = newRun("migracion-idempotente");
  assert.equal(run.runStatus, "in_progress");
  assert.equal(run.incompleteReason, null);
  // Tercera inicialización no pierde datos.
  initializeSecurityAuditSchema(db);
  assert.equal(getSecurityAuditRun(db, "migracion-idempotente")?.profile, "standard");
});

test("run status enforces the four official incomplete reasons", () => {
  const run = newRun("estados-oficiales");
  assert.throws(() => updateSecurityAuditRunStatus(db, run.runId, "incomplete"), /incomplete_reason/);
  assert.throws(
    () => updateSecurityAuditRunStatus(db, run.runId, "incomplete", "budget_exhausted" as never),
    /incomplete_reason/,
  );
  assert.throws(
    () => updateSecurityAuditRunStatus(db, run.runId, "complete", "critic_budget_exhausted" as never),
    /incomplete_reason/,
  );

  updateSecurityAuditRunStatus(db, run.runId, "incomplete", "validation_budget_exhausted");
  const incomplete = getSecurityAuditRun(db, run.runId);
  assert.equal(incomplete?.runStatus, "incomplete");
  assert.equal(incomplete?.incompleteReason, "validation_budget_exhausted");
  assert.ok(incomplete?.finishedAt);

  // complete limpia cualquier motivo previo imposible: exige reason null.
  setSecurityAuditPhase(db, run.runId, 1, "complete");
  updateSecurityAuditRunStatus(db, run.runId, "complete");
  const complete = getSecurityAuditRun(db, run.runId);
  assert.equal(complete?.runStatus, "complete");
  assert.equal(complete?.incompleteReason, null);

  requestSecurityAuditCancel(db, run.runId);
  assert.equal(isSecurityAuditCancelRequested(db, run.runId), true);
  assert.equal(isSecurityAuditCancelRequested(db, "inexistente"), false);
});

test("findings keep severity only for confirmed records", () => {
  const run = newRun("severidad-confirmada");
  upsertSecurityAuditFinding(db, run.runId, {
    fingerprint: "src-ok",
    verdict: "confirmed",
    severity: "high",
    payload: { title: "Confirmado" },
  });
  upsertSecurityAuditFinding(db, run.runId, {
    fingerprint: "src-pendiente",
    verdict: "needs_validation",
    severity: "critical",
    payload: { title: "Pendiente" },
  });
  const findings = listSecurityAuditFindings(db, run.runId);
  const confirmed = findings.find((finding) => finding.fingerprint === "src-ok");
  const pending = findings.find((finding) => finding.fingerprint === "src-pendiente");
  assert.equal(confirmed?.severity, "high");
  assert.equal(pending?.severity, null);

  // El CHECK de tabla también rechaza severidad fuera de confirmed.
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO security_audit_findings
             (run_id, fingerprint, verdict, severity, payload_json, created_at, updated_at)
           VALUES (?, 'ilegal', 'rejected', 'high', '{}', '2026-01-01', '2026-01-01')`,
        )
        .run(run.runId),
    /CHECK constraint failed/,
  );
});

test("provider errors are recorded without any automatic prompt replay", () => {
  const run = newRun("rate-limit-sin-replay");
  recordSecurityAuditInvocation(db, {
    instanceId: "inv-429",
    runId: run.runId,
    phase: 2,
    role: "hunter",
    engine: "opencode",
    model: "opencode-go/mimo-v2.6-flash",
    sessionId: "ses-1",
    agentRunId: "agent-run-1",
    handoffId: "HANDOFF-1",
    discovererInstanceId: null,
    verificationKind: "hunter",
  });
  finishSecurityAuditInvocation(db, "inv-429", "failed", {
    kind: "rate_limited",
    status: 429,
  });
  const [invocation] = listSecurityAuditInvocations(db, run.runId);
  assert.equal(invocation?.outcome, "failed");
  assert.equal(invocation?.providerErrorKind, "rate_limited");
  assert.equal(invocation?.providerStatus, 429);
  assert.equal(invocation?.autoReplay, false, "jamás reenvío automático de prompts");

  // La columna es inmutable: ni siquiera SQL directo permite replay.
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO security_audit_invocations
             (instance_id, run_id, phase, role, outcome, auto_replay, started_at, finished_at)
           VALUES ('inv-replay', ?, 2, 'hunter', 'succeeded', 1, '2026-01-01', '2026-01-01')`,
        )
        .run(run.runId),
    /CHECK constraint failed/,
  );
  // Y una invocación sin cerrar no puede declararse terminal.
  recordSecurityAuditInvocation(db, {
    instanceId: "inv-abierta",
    runId: run.runId,
    phase: 3,
    role: "verifier",
    verificationKind: "phase3",
  });
  assert.throws(
    () =>
      db
        .prepare(
          `UPDATE security_audit_invocations
             SET outcome = 'succeeded' WHERE instance_id = 'inv-abierta'`,
        )
        .run(),
    /CHECK constraint failed/,
  );
});

/**
 * F06: la fila inicia con veredicto real false (aunque esté planificada) y la
 * evidencia estructurada SOLO se registra con recordSecurityAuditCrossEngine-
 * Evidence, después de interpretar la salida. Una razón conservada nunca es un
 * éxito, y una fila inexistente rechaza la evidencia.
 */
test("cross-engine evidence starts false and only a real verdict flips it", () => {
  const run = newRun("cross-engine-evidencia");
  // El descubridor es un hunter real persistido (FK de discoverer_instance_id).
  recordSecurityAuditInvocation(db, {
    instanceId: "inv-hunter",
    runId: run.runId,
    phase: 2,
    role: "hunter",
    agentId: "reverse",
    engine: "opencode",
    model: "opencode-go/mimo-v2.6-flash",
    sessionId: "ses-hunter",
    agentRunId: "agent-run-hunter",
    handoffId: "HANDOFF-REVERSE-RUN",
    verificationKind: "hunter",
  });
  finishSecurityAuditInvocation(db, "inv-hunter", "succeeded");
  recordSecurityAuditInvocation(db, {
    instanceId: "inv-verificador",
    runId: run.runId,
    phase: 3,
    role: "candidate-verifier",
    agentId: "reviewer",
    engine: "claude",
    model: "anthropic/claude-sonnet-4-5",
    sessionId: "ses-verificador",
    agentRunId: "agent-run-verificador",
    handoffId: "HANDOFF-REVIEWER-RUN",
    discovererInstanceId: "inv-hunter",
    verificationKind: "phase3",
    fingerprint: "src-evidencia",
    crossEnginePlanned: true,
  });
  finishSecurityAuditInvocation(db, "inv-verificador", "succeeded");
  const before = getSecurityAuditInvocation(db, run.runId, "inv-verificador");
  assert.equal(before?.crossEnginePlanned, true, "la intención de plan queda registrada");
  assert.equal(before?.crossEngineVerified, false, "planificado NUNCA es éxito");
  assert.equal(before?.fingerprint, "src-evidencia");
  assert.equal(before?.crossEngineEvidence, null, "sin evidencia aún");

  const evidence = {
    fingerprint: "src-evidencia",
    planned: true,
    verified: true,
    reason: null,
    discoverer: {
      instanceId: "inv-hunter",
      sessionId: "ses-hunter",
      engine: "opencode",
      model: "opencode-go/mimo-v2.6-flash",
      handoffId: "HANDOFF-REVERSE-RUN",
      agentRunId: "agent-run-hunter",
    },
    verifier: {
      instanceId: "inv-verificador",
      sessionId: "ses-verificador",
      engine: "claude",
      model: "anthropic/claude-sonnet-4-5",
      handoffId: "HANDOFF-REVIEWER-RUN",
      agentRunId: "agent-run-verificador",
    },
    verifiedAt: "2026-01-01T00:00:00.000Z",
  };
  recordSecurityAuditCrossEngineEvidence(db, "inv-verificador", evidence);
  const after = getSecurityAuditInvocation(db, run.runId, "inv-verificador");
  assert.equal(after?.crossEngineVerified, true, "el veredicto real se registra con evidencia");
  assert.deepEqual(after?.crossEngineEvidence, evidence);
  const single = getSecurityAuditInvocation(db, run.runId, "inv-verificador");
  assert.equal(single?.crossEngineVerified, true);

  // La proponente de un reemplazo material también puede recibir un veredicto
  // false con su razón: nunca un éxito sin evidencia.
  recordSecurityAuditInvocation(db, {
    instanceId: "inv-proponente",
    runId: run.runId,
    phase: 5,
    role: "record-verifier",
    agentId: "build",
    engine: "opencode",
    verificationKind: "phase5",
    fingerprint: "src-evidencia",
    crossEnginePlanned: true,
  });
  recordSecurityAuditCrossEngineEvidence(db, "inv-proponente", {
    ...evidence,
    verified: false,
    reason: "independent_verification_invalid",
    verifiedAt: null,
  });
  const [proposer] = listSecurityAuditInvocations(db, run.runId)
    .filter((row) => row.instanceId === "inv-proponente");
  assert.equal(proposer?.crossEngineVerified, false);
  assert.equal(proposer?.crossEngineEvidence?.reason, "independent_verification_invalid");

  // Una fila inexistente rechaza la evidencia (nunca se inventa un registro).
  assert.throws(
    () => recordSecurityAuditCrossEngineEvidence(db, "inv-inexistente", evidence),
    /inexistente/,
  );
});

test("remediation never reaches verified_fixed without evidence", () => {
  const run = newRun("remediacion-con-evidencia");
  createSecurityAuditRemediation(db, { runId: run.runId, fingerprint: "src-fix" });
  assert.equal(listSecurityAuditRemediations(db, run.runId)[0]?.state, "requested");

  // executionRunId opcional, pero si se declara debe existir (FK a execution_runs).
  assert.throws(
    () =>
      createSecurityAuditRemediation(db, {
        runId: run.runId,
        fingerprint: "src-con-ejecucion",
        executionRunId: "ejecucion-inexistente",
      }),
    /FOREIGN KEY|no such table/,
  );

  assert.throws(
    () => transitionSecurityAuditRemediation(db, run.runId, "src-fix", "verified_fixed", []),
    /evidencia/,
  );
  transitionSecurityAuditRemediation(db, run.runId, "src-fix", "in_progress");
  transitionSecurityAuditRemediation(db, run.runId, "src-fix", "verified_fixed", [
    { evidence: "prueba-regresión-pasada" },
  ]);
  const [remediation] = listSecurityAuditRemediations(db, run.runId);
  assert.equal(remediation?.state, "verified_fixed");
  assert.equal(remediation?.evidence.length, 1);

  // CHECK de tabla: sin evidencia no hay verified_fixed ni con SQL directo.
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO security_audit_remediations
             (run_id, fingerprint, state, evidence_json, created_at, updated_at)
           VALUES (?, 'src-sin-evidencia', 'verified_fixed', '[]', '2026-01-01', '2026-01-01')`,
        )
        .run(run.runId),
    /CHECK constraint failed/,
  );
});

test("reconciliation reports database versus official files without mutating either", () => {
  const run = newRun("reconciliacion");
  upsertSecurityAuditUnits(db, run.runId, [
    { unitId: "unit-a", status: "covered" },
    { unitId: "unit-b", status: "candidate" },
    { unitId: "unit-db-only", status: "planned" },
  ]);
  upsertSecurityAuditFinding(db, run.runId, {
    fingerprint: "fp-igual",
    verdict: "confirmed",
    severity: "low",
    payload: {},
  });
  upsertSecurityAuditFinding(db, run.runId, {
    fingerprint: "fp-cambiado",
    verdict: "rejected",
    payload: {},
  });

  const report = reconcileSecurityAuditRun(db, run.runId, {
    ledgerUnits: [
      { coverage_id: "unit-a", status: "covered" },
      { coverage_id: "unit-b", status: "deferred" },
      { coverage_id: "unit-solo-archivo", status: "planned" },
    ],
    findings: [
      { fingerprint: "fp-igual", verdict: "confirmed", severity: "low" },
      { fingerprint: "fp-cambiado", verdict: "needs_validation" },
      { fingerprint: "fp-solo-archivo", verdict: "rejected" },
    ],
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.units.missingInDatabase, ["unit-solo-archivo"]);
  assert.deepEqual(report.units.missingInFile, ["unit-db-only"]);
  assert.deepEqual(report.units.statusMismatches, [
    { unitId: "unit-b", database: "candidate", file: "deferred" },
  ]);
  assert.deepEqual(report.findings.missingInDatabase, ["fp-solo-archivo"]);
  assert.deepEqual(report.findings.missingInFile, []);
  assert.deepEqual(report.findings.verdictMismatches, [
    { fingerprint: "fp-cambiado", database: "rejected", file: "needs_validation" },
  ]);

  // La reconciliación no escribe: la base conserva sus valores originales.
  const units = listSecurityAuditUnits(db, run.runId);
  assert.equal(units.find((unit) => unit.unitId === "unit-b")?.status, "candidate");
  const findings = listSecurityAuditFindings(db, run.runId);
  assert.equal(
    findings.find((finding) => finding.fingerprint === "fp-cambiado")?.verdict,
    "rejected",
  );

  const clean = reconcileSecurityAuditRun(db, run.runId, {
    ledgerUnits: units.map((unit) => ({ unitId: unit.unitId, status: unit.status })),
    findings: findings.map((finding) => ({
      fingerprint: finding.fingerprint,
      verdict: finding.verdict,
      severity: finding.severity,
    })),
  });
  assert.equal(clean.ok, true);
});

test("resume plan never repeats completed phases", () => {
  const run = newRun("reanudacion");
  for (const phase of [1, 2]) {
    setSecurityAuditPhase(db, run.runId, phase, "complete");
    recordSecurityAuditCheckpoint(db, run.runId, phase, "complete", { phase });
  }
  setSecurityAuditPhase(db, run.runId, 3, "in_progress");
  recordSecurityAuditCheckpoint(db, run.runId, 3, "in_progress", { phase: 3 });

  const plan = planSecurityAuditResume(db, run.runId);
  assert.deepEqual(plan.completedPhases, [1, 2]);
  assert.deepEqual(plan.pendingPhases, [3, 4, 5, 6]);
  assert.equal(plan.nextPhase, 3);
  assert.deepEqual(plan.phasesNotToRepeat, [1, 2]);

  const checkpoint = getSecurityAuditCheckpoint(db, run.runId, 2);
  assert.equal(checkpoint?.state, "complete");
  assert.equal(checkpoint?.payloadSha256.length, 64);

  setSecurityAuditValidators(db, run.runId, { ledger: "pass", findings: "pass" });
  for (const phase of [3, 4, 5, 6]) {
    setSecurityAuditPhase(db, run.runId, phase, "complete");
    recordSecurityAuditCheckpoint(db, run.runId, phase, "complete", { phase });
  }
  updateSecurityAuditRunStatus(db, run.runId, "complete");
  const finished = planSecurityAuditResume(db, run.runId);
  assert.equal(finished.nextPhase, null);
  assert.deepEqual(finished.completedPhases, [1, 2, 3, 4, 5, 6]);
});

test("data of different runs stays independent", () => {
  const first = newRun("run-independiente-a");
  const second = newRun("run-independiente-b");
  upsertSecurityAuditUnits(db, first.runId, [{ unitId: "unit-a", status: "covered" }]);
  upsertSecurityAuditUnits(db, second.runId, [{ unitId: "unit-b", status: "planned" }]);
  upsertSecurityAuditFinding(db, first.runId, {
    fingerprint: "fp-a",
    verdict: "confirmed",
    severity: "medium",
    payload: {},
  });
  recordSecurityAuditCheckpoint(db, first.runId, 1, "complete", {});

  assert.deepEqual(
    listSecurityAuditUnits(db, first.runId).map((unit) => unit.unitId),
    ["unit-a"],
  );
  assert.deepEqual(
    listSecurityAuditUnits(db, second.runId).map((unit) => unit.unitId),
    ["unit-b"],
  );
  assert.deepEqual(
    listSecurityAuditFindings(db, second.runId).map((finding) => finding.fingerprint),
    [],
  );
  assert.equal(getSecurityAuditCheckpoint(db, second.runId, 1), null);
  assert.equal(getSecurityAuditRun(db, "run-inexistente"), null);

  // Un run_id duplicado es un error de integridad.
  assert.throws(() => newRun("run-independiente-a"), /UNIQUE|PRIMARY KEY/);
});

test("budget spend, reserves and configuration are stored as evidence", () => {
  const run = newRun("presupuesto-evidencia");
  updateSecurityAuditBudget(db, run.runId, {
    spent: { recon: 4, hunters: 3, critics: 1, verifiers: 1 },
    reserved: { recon: 0, critics: 1, validation: 1 },
    config: { maxInvocations: 12, maxConcurrency: 2, maxDurationMs: 60_000 },
  });
  const stored = getSecurityAuditRun(db, run.runId);
  assert.deepEqual(stored?.budgetSpent, { recon: 4, hunters: 3, critics: 1, verifiers: 1 });
  assert.deepEqual(stored?.budgetReserved, { recon: 0, critics: 1, validation: 1 });
  assert.deepEqual(stored?.budgetConfig, {
    maxInvocations: 12,
    maxConcurrency: 2,
    maxDurationMs: 60_000,
  });
  assert.equal(stored?.maxDurationMs, null, "la columna sigue separada del JSON de config");
});

/** Snapshot vacío (solo lo imprescindible) para fabricar estados de trabajo. */
function emptyWorkState() {
  return {
    candidateById: {},
    discovererByFingerprint: {},
    phase3InstanceByFingerprint: {},
    quickPhase3FinalVerified: {},
    unitIdByFingerprint: {},
    findings: {},
    unvalidated: [],
    deferred: [],
    pendingReasons: [] as SecurityAuditIncompleteReason[],
    cursor: 0,
    instanceCounter: 0,
    wavesStarted: 0,
    startedAt: "",
    deadlineAt: "",
    ledgerValidator: "pending" as const,
    findingsValidator: "pending" as const,
    consolidations: [],
    consolidatedUnitIds: {},
  };
}

test("work state persists mutable maps transactionally and validates JSON on read (F03)", () => {
  const run = newRun("estado-trabajo");
  saveSecurityAuditWorkState(db, run.runId, {
    ...emptyWorkState(),
    candidateById: { "fp-1": { fingerprint: "fp-1", title: "Candidato", description: "d" } },
    discovererByFingerprint: { "fp-1": { instanceId: "sa-estado-trabajo-1-abcd1234", engine: "opencode" } },
    phase3InstanceByFingerprint: { "fp-1": "sa-estado-trabajo-2-efef5678" },
    unitIdByFingerprint: { "fp-1": "unit-1" },
    findings: { "fp-1": { verdict: "confirmed", fingerprint: "fp-1", title: "t", description: "d" } },
    unvalidated: ["fp-2"],
    deferred: ["unit-9"],
    pendingReasons: ["critic_budget_exhausted"],
    cursor: 7,
    instanceCounter: 12,
    wavesStarted: 2,
    ledgerValidator: "fail",
    findingsValidator: "pass",
  });

  const loaded = loadSecurityAuditWorkState(db, run.runId);
  assert.ok(loaded, "el estado de trabajo se recupera");
  assert.deepEqual(loaded?.candidateById["fp-1"], { fingerprint: "fp-1", title: "Candidato", description: "d" });
  assert.deepEqual(loaded?.discovererByFingerprint["fp-1"], {
    instanceId: "sa-estado-trabajo-1-abcd1234",
    engine: "opencode",
  });
  assert.equal(loaded?.phase3InstanceByFingerprint["fp-1"], "sa-estado-trabajo-2-efef5678");
  assert.deepEqual(loaded?.findings["fp-1"], { verdict: "confirmed", fingerprint: "fp-1", title: "t", description: "d" });
  assert.deepEqual(loaded?.unvalidated, ["fp-2"]);
  assert.deepEqual(loaded?.deferred, ["unit-9"]);
  assert.deepEqual(loaded?.pendingReasons, ["critic_budget_exhausted"]);
  assert.equal(loaded?.cursor, 7);
  assert.equal(loaded?.instanceCounter, 12);
  assert.equal(loaded?.wavesStarted, 2);
  assert.equal(loaded?.ledgerValidator, "fail");
  assert.equal(loaded?.findingsValidator, "pass");

  // Upsert transaccional: una sola fila por run, la segunda escritura reemplaza.
  saveSecurityAuditWorkState(db, run.runId, { ...emptyWorkState(), cursor: 9 });
  const reloaded = loadSecurityAuditWorkState(db, run.runId);
  assert.equal(reloaded?.cursor, 9);
  assert.deepEqual(reloaded?.candidateById, {}, "la segunda escritura reemplaza el snapshot");
  const rows = db
    .prepare("SELECT COUNT(*) AS total FROM security_audit_work_state WHERE run_id = ?")
    .get(run.runId) as { total: number };
  assert.equal(rows.total, 1);

  // JSON corrupto en la tabla: la lectura devuelve null (nunca un pass forzado
  // ni instrucciones derivadas de basura).
  db.prepare("UPDATE security_audit_work_state SET state_json = '{corrupto' WHERE run_id = ?")
    .run(run.runId);
  assert.equal(loadSecurityAuditWorkState(db, run.runId), null);

  // Campos malformados: se descartan campo a campo, sin inventar nada.
  saveSecurityAuditWorkState(db, run.runId, {
    ...emptyWorkState(),
    discovererByFingerprint: { "fp-x": { instanceId: "", engine: "motor-inexistente" } } as never,
    pendingReasons: ["motivo_falso"] as never,
    cursor: -3 as never,
  });
  const sanitized = loadSecurityAuditWorkState(db, run.runId);
  assert.deepEqual(sanitized?.discovererByFingerprint, {});
  assert.deepEqual(sanitized?.pendingReasons, []);
  assert.equal(sanitized?.cursor, 0);
});

test("with checkpoints 1..6 complete the plan resumes at the phase that fixes the gap (F03)", () => {
  function fullRun(runId: string) {
    const run = newRun(runId);
    for (const phase of [1, 2, 3, 4, 5, 6]) {
      setSecurityAuditPhase(db, run.runId, phase, "complete");
      recordSecurityAuditCheckpoint(db, run.runId, phase, "complete", { phase });
    }
    return run;
  }

  // Gap de crítico/presupuesto → fase 2; los checkpoints posteriores quedan
  // descartados del PLAN pero sus filas (historial) siguen en la base.
  const critic = fullRun("gap-critico");
  saveSecurityAuditWorkState(db, critic.runId, { ...emptyWorkState(), pendingReasons: ["critic_budget_exhausted"], wavesStarted: 1 });
  const criticPlan = planSecurityAuditResume(db, critic.runId);
  assert.equal(criticPlan.nextPhase, 2);
  assert.deepEqual(criticPlan.completedPhases, [1]);
  assert.deepEqual(criticPlan.pendingPhases, [2, 3, 4, 5, 6]);
  assert.deepEqual(criticPlan.phasesNotToRepeat, [1]);
  assert.equal(getSecurityAuditCheckpoint(db, critic.runId, 4)?.state, "complete", "el historial de checkpoints no se borra");

  // Candidatos pendientes de fase 3 → fase 3.
  const candidates = fullRun("gap-candidatos");
  upsertSecurityAuditUnits(db, candidates.runId, [{
    unitId: "unit-c",
    status: "candidate",
    payload: { result_fingerprints: ["fp-c"] },
  }]);
  assert.equal(planSecurityAuditResume(db, candidates.runId).nextPhase, 3);

  // Validador oficial en fail → fase 4 (salida estructurada).
  const validators = fullRun("gap-validadores");
  setSecurityAuditValidators(db, validators.runId, { findings: "fail" });
  assert.equal(planSecurityAuditResume(db, validators.runId).nextPhase, 4);

  // Fingerprints sin validar sin unidades candidatas → fase 5 (registro final).
  const unvalidated = fullRun("gap-registro-final");
  setSecurityAuditValidators(db, unvalidated.runId, { ledger: "pass", findings: "pass" });
  saveSecurityAuditWorkState(db, unvalidated.runId, { ...emptyWorkState(), unvalidated: ["fp-final"] });
  assert.equal(planSecurityAuditResume(db, unvalidated.runId).nextPhase, 5);

  // Run incomplete sin ningún otro hueco registrado → publicar informes (6).
  const reports = fullRun("gap-informes");
  setSecurityAuditValidators(db, reports.runId, { ledger: "pass", findings: "pass" });
  saveSecurityAuditWorkState(db, reports.runId, emptyWorkState());
  updateSecurityAuditRunStatus(db, reports.runId, "incomplete", "orchestrator_failed");
  assert.equal(planSecurityAuditResume(db, reports.runId).nextPhase, 6);

  // Run complete y sin huecos → no se reanuda.
  const complete = fullRun("gap-ninguno");
  setSecurityAuditValidators(db, complete.runId, { ledger: "pass", findings: "pass" });
  updateSecurityAuditRunStatus(db, complete.runId, "complete");
  assert.equal(planSecurityAuditResume(db, complete.runId).nextPhase, null);
  assert.deepEqual(planSecurityAuditResume(db, complete.runId).completedPhases, [1, 2, 3, 4, 5, 6]);
});

/**
 * F07: historial append-only de hallazgos. Un `confirmed` retirado de la
 * proyección conserva su copia completa (payload, verificación y razón) en el
 * historial y DEJA de ser remediable: ya no está en `security_audit_findings`.
 */
test("a confirmed finding removed from the projection keeps history and stops being remediable (F07)", () => {
  const run = newRun("historial-retiro");
  const record = {
    fingerprint: "fp-retirado",
    verdict: "confirmed" as const,
    severity: "high" as const,
    payload: {
      verdict: "confirmed",
      fingerprint: "fp-retirado",
      title: "Confirmado",
      description: "Registro activo antes del retiro.",
      severity: { overall_severity: "high" },
    },
    verificationHistory: [{ decision: "verified", fingerprint: "fp-retirado", phase: 5 }],
  };
  reconcileSecurityAuditFindingsProjection(db, run.runId, { records: [record] });
  let findings = listSecurityAuditFindings(db, run.runId);
  assert.equal(findings.length, 1, "el registro activo está en la proyección");
  assert.equal(findings[0]?.verdict, "confirmed");
  assert.equal(findings[0]?.severity, "high");
  assert.deepEqual(findings[0]?.verificationHistory, record.verificationHistory);
  assert.deepEqual(listSecurityAuditRetiredFingerprints(db, run.runId), []);

  // Fase 5 lo retira del mapa: la proyección se reconcilia SIN él, con razón.
  const report = reconcileSecurityAuditFindingsProjection(db, run.runId, {
    records: [],
    retirements: new Map([["fp-retirado", "verification_unverified"]]),
    fallbackRetirementReason: "removed_from_findings_map",
  });
  assert.deepEqual(report.retired, [{ fingerprint: "fp-retirado", reason: "verification_unverified" }]);
  findings = listSecurityAuditFindings(db, run.runId);
  assert.equal(findings.length, 0, "el retiro desaparece de la proyección");

  // El historial conservó el estado completo ANTES de borrar la fila.
  const history = listSecurityAuditFindingsHistory(db, run.runId);
  assert.equal(history.length, 1);
  const entry = history[0];
  assert.equal(entry?.fingerprint, "fp-retirado");
  assert.equal(entry?.verdict, "confirmed");
  assert.equal(entry?.severity, "high");
  assert.deepEqual(entry?.payload, record.payload);
  assert.deepEqual(entry?.verificationHistory, record.verificationHistory);
  assert.equal(entry?.retirementReason, "verification_unverified");
  assert.ok(entry?.recordedAt);
  assert.deepEqual(listSecurityAuditRetiredFingerprints(db, run.runId), ["fp-retirado"]);
});

/**
 * F07: un reemplazo NO resetea el historial ni la verificación previa; el
 * estado anterior queda en el historial con razón `replacement`.
 */
test("a replacement keeps the previous verification history instead of resetting it (F07)", () => {
  const run = newRun("historial-reemplazo");
  const verification = [{ decision: "verified", fingerprint: "fp-reemplazo", phase: 3 }];
  reconcileSecurityAuditFindingsProjection(db, run.runId, {
    records: [{
      fingerprint: "fp-reemplazo",
      verdict: "confirmed",
      severity: "medium",
      payload: { verdict: "confirmed", fingerprint: "fp-reemplazo", title: "Original", description: "d" },
      verificationHistory: verification,
    }],
  });
  // Reemplazo con OTRO veredicto: la fila previa pasa al historial completa.
  reconcileSecurityAuditFindingsProjection(db, run.runId, {
    records: [{
      fingerprint: "fp-reemplazo",
      verdict: "needs_validation",
      severity: null,
      payload: { verdict: "needs_validation", fingerprint: "fp-reemplazo", title: "Reemplazo", description: "d2" },
      verificationHistory: null, // sin historial nuevo: se conserva el previo
    }],
  });
  const [row] = listSecurityAuditFindings(db, run.runId);
  assert.equal(row?.verdict, "needs_validation");
  assert.equal(row?.severity, null, "la severidad solo sobrevive en confirmed");
  assert.deepEqual(
    row?.verificationHistory,
    verification,
    "el reemplazo NO resetea la verificación a []",
  );
  const history = listSecurityAuditFindingsHistory(db, run.runId);
  assert.equal(history.length, 1);
  const entry = history[0];
  assert.equal(entry?.retirementReason, "replacement");
  assert.equal(entry?.verdict, "confirmed");
  assert.equal(entry?.severity, "medium");
  assert.deepEqual(entry?.payload, {
    verdict: "confirmed",
    fingerprint: "fp-reemplazo",
    title: "Original",
    description: "d",
  });
  assert.deepEqual(entry?.verificationHistory, verification);
});

/** F07: un `rejected` nunca recibe severidad en la proyección. */
test("a rejected record never carries severity in the projection (F07)", () => {
  const run = newRun("rechazo-sin-severidad");
  reconcileSecurityAuditFindingsProjection(db, run.runId, {
    records: [{
      fingerprint: "fp-rechazado",
      verdict: "rejected",
      severity: "high" as never,
      payload: { verdict: "rejected", fingerprint: "fp-rechazado", title: "t", description: "d" },
    }],
  });
  const [row] = listSecurityAuditFindings(db, run.runId);
  assert.equal(row?.verdict, "rejected");
  assert.equal(row?.severity, null);
});

/**
 * F07: la reconciliación de unidades elimina transaccionalmente las stale y
 * preserva los attempts DENTRO del payload de las unidades vivas.
 */
test("unit reconciliation removes stale units without losing attempts in live payloads (F07)", () => {
  const run = newRun("unidades-stale");
  upsertSecurityAuditUnits(db, run.runId, [
    { unitId: "unit-viva", status: "covered", payload: { coverage_id: "unit-viva", attempts: [{ wave: 1, agent_id: "reverse" }] } },
    { unitId: "unit-stale", status: "planned" },
  ]);
  // El ledger oficial ya no contiene unit-stale y actualiza la viva.
  const result = reconcileSecurityAuditUnits(db, run.runId, [
    {
      unitId: "unit-viva",
      status: "covered",
      payload: {
        coverage_id: "unit-viva",
        attempts: [{ wave: 1, agent_id: "reverse" }, { wave: 2, agent_id: "implementer" }],
      },
    },
  ]);
  assert.deepEqual(result.removed, ["unit-stale"]);
  const units = listSecurityAuditUnits(db, run.runId);
  assert.deepEqual(units.map((unit) => unit.unitId), ["unit-viva"]);
  assert.deepEqual(
    (units[0]?.payload as { attempts?: unknown[] }).attempts,
    [{ wave: 1, agent_id: "reverse" }, { wave: 2, agent_id: "implementer" }],
    "los attempts del payload de la unidad viva se conservan",
  );

  // Equivalencia exacta con el artefacto: reconcileSecurityAuditRun en PASS.
  const report = reconcileSecurityAuditRun(db, run.runId, {
    ledgerUnits: units.map((unit) => ({ unitId: unit.unitId, status: unit.status })),
    findings: [],
  });
  assert.equal(report.ok, true);
  assert.deepEqual(report.units.missingInFile, [], "sin unidades stale tras la reconciliación");
});

/** F07: el retiro con transacción fallida no deja la base a medias. */
test("projection reconciliation is transactional: a failure rolls back everything (F07)", () => {
  const run = newRun("transaccion-retiro");
  reconcileSecurityAuditFindingsProjection(db, run.runId, {
    records: [{
      fingerprint: "fp-integro",
      verdict: "confirmed",
      severity: "low",
      payload: { verdict: "confirmed", fingerprint: "fp-integro", title: "t", description: "d" },
    }],
  });
  // Un registro con veredicto inválido revienta la transacción completa.
  assert.throws(
    () =>
      reconcileSecurityAuditFindingsProjection(db, run.runId, {
        records: [
          {
            fingerprint: "fp-integro",
            verdict: "confirmed",
            severity: null,
            payload: { verdict: "confirmed", fingerprint: "fp-integro", title: "t2", description: "d" },
          },
          {
            fingerprint: "fp-malo",
            verdict: "invalido" as never,
            severity: null,
            payload: {},
          },
        ],
      }),
    /verdict/,
  );
  const rows = db
    .prepare("SELECT COUNT(*) AS total FROM security_audit_findings_history WHERE run_id = ?")
    .get(run.runId) as { total: number };
  assert.equal(rows.total, 0, "sin historial parcial");
  const findings = listSecurityAuditFindings(db, run.runId);
  assert.equal(findings.length, 1);
  assert.equal(
    (findings[0]?.payload as { title?: string }).title,
    "t",
    "la proyección previa queda intacta",
  );
});

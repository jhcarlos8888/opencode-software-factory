import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  createSecurityAuditRun,
  getSecurityAuditRun,
  initializeSecurityAuditSchema,
  listSecurityAuditInvocations,
  recordSecurityAuditCrossEngineEvidence,
  updateSecurityAuditRunStatus,
} from "./security-audit-persistence.js";

/**
 * Migración de reconstrucción de `security_audit_runs` (P3): una base creada
 * con el CHECK antiguo de solo cuatro motivos de presupuesto debe reconstruirse
 * para admitir los motivos operativos de cierre terminal, sin perder datos,
 * columnas, índices ni integridad referencial, y sin ignorar ningún CHECK.
 */

const isolatedDir = mkdtempSync(join(tmpdir(), "factory-security-audit-migration-"));
const dbPath = join(isolatedDir, "legacy.sqlite");
const db = new DatabaseSync(dbPath);

after(() => {
  db.close();
  rmSync(isolatedDir, { recursive: true, force: true });
});

/** DDL exacto del esquema ANTERIOR (solo los cuatro motivos de presupuesto). */
const LEGACY_RUNS_TABLE = `
  CREATE TABLE security_audit_runs (
    run_id TEXT PRIMARY KEY,
    project_path TEXT NOT NULL,
    source_ref TEXT,
    source_dirty INTEGER NOT NULL DEFAULT 0 CHECK (source_dirty IN (0, 1)),
    profile TEXT NOT NULL CHECK (profile IN ('quick', 'standard', 'deep')),
    intent TEXT NOT NULL CHECK (intent IN ('guidance', 'full_audit', 'remediation')),
    scope_json TEXT NOT NULL DEFAULT '{}',
    budget_config_json TEXT NOT NULL DEFAULT '{}',
    budget_spent_json TEXT NOT NULL DEFAULT '{}',
    budget_reserved_json TEXT NOT NULL DEFAULT '{}',
    max_concurrency INTEGER NOT NULL DEFAULT 1 CHECK (max_concurrency >= 1),
    max_duration_ms INTEGER,
    phase_1 TEXT NOT NULL DEFAULT 'pending' CHECK (phase_1 IN ('pending', 'in_progress', 'complete', 'skipped')),
    phase_2 TEXT NOT NULL DEFAULT 'pending' CHECK (phase_2 IN ('pending', 'in_progress', 'complete', 'skipped')),
    phase_3 TEXT NOT NULL DEFAULT 'pending' CHECK (phase_3 IN ('pending', 'in_progress', 'complete', 'skipped')),
    phase_4 TEXT NOT NULL DEFAULT 'pending' CHECK (phase_4 IN ('pending', 'in_progress', 'complete', 'skipped')),
    phase_5 TEXT NOT NULL DEFAULT 'pending' CHECK (phase_5 IN ('pending', 'in_progress', 'complete', 'skipped')),
    phase_6 TEXT NOT NULL DEFAULT 'pending' CHECK (phase_6 IN ('pending', 'in_progress', 'complete', 'skipped')),
    run_status TEXT NOT NULL DEFAULT 'in_progress'
      CHECK (run_status IN ('in_progress', 'complete', 'incomplete')),
    incomplete_reason TEXT CHECK (
      incomplete_reason IS NULL OR incomplete_reason IN (
        'budget_cannot_fund_reconnaissance_and_reserves',
        'budget_cannot_reserve_critics_and_validation',
        'critic_budget_exhausted',
        'validation_budget_exhausted'
      )
    ),
    output_dir TEXT NOT NULL,
    execution_policy TEXT NOT NULL DEFAULT 'source-only'
      CHECK (execution_policy IN ('source-only', 'sandboxed-source-and-local-only')),
    sandbox_status TEXT NOT NULL DEFAULT 'source_only'
      CHECK (sandbox_status IN ('source_only', 'sandboxed', 'unavailable')),
    sandbox_evidence_json TEXT NOT NULL DEFAULT '[]',
    sandbox_blockers_json TEXT NOT NULL DEFAULT '[]',
    ledger_validator TEXT NOT NULL DEFAULT 'pending'
      CHECK (ledger_validator IN ('pending', 'pass', 'fail')),
    findings_validator TEXT NOT NULL DEFAULT 'pending'
      CHECK (findings_validator IN ('pending', 'pass', 'fail')),
    cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    finished_at TEXT,
    CHECK (run_status <> 'incomplete' OR incomplete_reason IS NOT NULL),
    CHECK (run_status = 'incomplete' OR incomplete_reason IS NULL)
  )`;

/** Tabla hija real con FK `ON DELETE CASCADE` sobre `security_audit_runs`. */
const LEGACY_UNITS_TABLE = `
  CREATE TABLE security_audit_units (
    run_id TEXT NOT NULL REFERENCES security_audit_runs(run_id) ON DELETE CASCADE,
    unit_id TEXT NOT NULL,
    coverage_id TEXT,
    wave INTEGER NOT NULL DEFAULT 0 CHECK (wave >= 0),
    status TEXT NOT NULL DEFAULT 'planned' CHECK (
      status IN ('planned', 'not_applicable', 'out_of_scope', 'in_progress',
                 'covered', 'candidate', 'blocked', 'deferred')
    ),
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (run_id, unit_id)
  )`;

// Base legada: tabla de runs con el CHECK de cuatro motivos + hija con FK.
db.exec(LEGACY_RUNS_TABLE);
db.exec(LEGACY_UNITS_TABLE);
db.exec(`CREATE INDEX idx_legacy_units_status ON security_audit_units(run_id, status)`);

// Fila legada con motivo de presupuesto (el único tipo que el CHECK aceptaba).
db.prepare(
  `INSERT INTO security_audit_runs
     (run_id, project_path, source_ref, source_dirty, profile, intent, scope_json,
      budget_config_json, output_dir, created_at, updated_at)
   VALUES ('legacy-run', '/srv/legacy', 'abc123', 1, 'standard', 'full_audit', '{"kind":"project"}',
           '{"maxInvocations":20}', '/tmp/legacy-out', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
).run();
// Estado incompleto con motivo de presupuesto (válido en el esquema legado).
db.prepare(
  `UPDATE security_audit_runs
      SET run_status = 'incomplete',
          incomplete_reason = 'critic_budget_exhausted',
          finished_at = '2026-01-02T00:00:00.000Z'
    WHERE run_id = 'legacy-run'`,
).run();
// Fila hija que referencia al run (riesgo real de borrado en cascada).
db.prepare(
  `INSERT INTO security_audit_units (run_id, unit_id, coverage_id, payload_json, created_at, updated_at)
   VALUES ('legacy-run', 'unit-1', 'cov-1', '{"status":"planned"}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
).run();
// Índice legado sobre la tabla que se va a reconstruir (debe conservarse).
db.exec("CREATE INDEX idx_legacy_runs_status ON security_audit_runs(run_status)");

test("legacy database is rebuilt with operational reasons without losing data or FKs", () => {
  // El CHECK legado rechaza de verdad los motivos operativos (prueba previa).
  assert.throws(
    () =>
      db
        .prepare(
          `UPDATE security_audit_runs SET run_status = 'incomplete', incomplete_reason = 'execution_interrupted'
            WHERE run_id = 'legacy-run'`,
        )
        .run(),
    /CHECK constraint failed|constraint failed/i,
    "el esquema legado no acepta motivos operativos antes de migrar",
  );

  // Migración (idempotente: dos pasadas seguidas).
  initializeSecurityAuditSchema(db);
  initializeSecurityAuditSchema(db);

  // 1) Datos conservados exactamente.
  const run = getSecurityAuditRun(db, "legacy-run");
  assert.ok(run, "la fila legada se conserva");
  assert.equal(run?.profile, "standard");
  assert.equal(run?.intent, "full_audit");
  assert.equal(run?.projectPath, "/srv/legacy");
  assert.equal(run?.sourceRef, "abc123");
  assert.equal(run?.sourceDirty, true);
  assert.equal(run?.runStatus, "incomplete");
  assert.equal(run?.incompleteReason, "critic_budget_exhausted");
  assert.equal(run?.outputDir, "/tmp/legacy-out");
  assert.equal(run?.finishedAt, "2026-01-02T00:00:00.000Z");
  assert.deepEqual(run?.scope, { kind: "project" });

  // 2) Fila hija intacta (el DROP no disparó el CASCADE).
  const units = db
    .prepare("SELECT unit_id FROM security_audit_units WHERE run_id = 'legacy-run'")
    .all() as unknown as Array<{ unit_id: string }>;
  assert.deepEqual(
    units.map((row) => row.unit_id),
    ["unit-1"],
    "las filas hijas sobreviven a la reconstrucción",
  );

  // 3) El CHECK nuevo admite los motivos operativos… (sin ignorar constraints).
  updateSecurityAuditRunStatus(db, "legacy-run", "incomplete", "execution_interrupted");
  const migrated = getSecurityAuditRun(db, "legacy-run");
  assert.equal(migrated?.incompleteReason, "execution_interrupted");

  // 4) …y sigue rechazando motivos no oficiales (CHECK activo, no desactivado).
  assert.throws(
    () => updateSecurityAuditRunStatus(db, "legacy-run", "incomplete", "not_a_real_reason" as never),
    /incomplete_reason inválido/,
    "el CHECK sigue activo tras la reconstrucción",
  );
  assert.throws(
    () =>
      db
        .prepare(
          `UPDATE security_audit_runs SET run_status = 'incomplete', incomplete_reason = 'invented_reason'
            WHERE run_id = 'legacy-run'`,
        )
        .run(),
    /CHECK constraint failed|constraint failed/i,
    "el CHECK de la tabla reconstruida sigue activo a nivel SQL",
  );

  // 5) Motivos oficiales de presupuesto siguen funcionando.
  updateSecurityAuditRunStatus(db, "legacy-run", "incomplete", "validation_budget_exhausted");
  assert.equal(getSecurityAuditRun(db, "legacy-run")?.incompleteReason, "validation_budget_exhausted");

  // 6) `foreign_key_check` sin violaciones tras la reconstrucción.
  const violations = db.prepare("PRAGMA foreign_key_check").all();
  assert.deepEqual(violations, [], "sin violaciones de integridad referencial");

  // 7) Índices legados sobre la tabla reconstruida conservados.
  const indexNames = (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'security_audit_runs'")
      .all() as unknown as Array<{ name: string }>
  ).map((row) => row.name);
  assert.ok(
    indexNames.includes("idx_legacy_runs_status"),
    "el índice legado sobre security_audit_runs se recrea: " + indexNames.join(", "),
  );

  // 8) Otras tablas y datos ajenos no se tocan.
  const notes = db.prepare("SELECT COUNT(*) AS total FROM sqlite_master WHERE name = 'security_audit_units'").get() as {
    total: number;
  };
  assert.equal(notes.total, 1);

  // 9) Migración nueva: crear un run desde cero funciona con motivo operativo.
  createSecurityAuditRun(db, {
    runId: "fresh-run",
    projectPath: "/srv/fresh",
    profile: "quick",
    intent: "full_audit",
    outputDir: join(isolatedDir, "output", "fresh-run"),
  });
  updateSecurityAuditRunStatus(db, "fresh-run", "incomplete", "provider_unavailable");
  assert.equal(getSecurityAuditRun(db, "fresh-run")?.incompleteReason, "provider_unavailable");
});

test("a failed migration rolls back completely and the legacy database stays intact", () => {
  const rollbackDir = mkdtempSync(join(tmpdir(), "factory-security-audit-migration-rollback-"));
  const rollbackDb = new DatabaseSync(join(rollbackDir, "rollback.sqlite"));
  try {
    rollbackDb.exec(LEGACY_RUNS_TABLE);
    rollbackDb.exec(LEGACY_UNITS_TABLE);
    // Fila legada + hija dependiente + índice legado (mismo escenario que la
    // migración exitosa, sobre otra base).
    rollbackDb.prepare(
      `INSERT INTO security_audit_runs
         (run_id, project_path, profile, intent, scope_json, budget_config_json,
          output_dir, created_at, updated_at)
       VALUES ('legacy-rollback', '/srv/rollback', 'standard', 'full_audit', '{"kind":"project"}',
               '{}', '/tmp/rollback-out', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run();
    rollbackDb.prepare(
      `UPDATE security_audit_runs
          SET run_status = 'incomplete', incomplete_reason = 'critic_budget_exhausted'
        WHERE run_id = 'legacy-rollback'`,
    ).run();
    rollbackDb.prepare(
      `INSERT INTO security_audit_units (run_id, unit_id, payload_json, created_at, updated_at)
       VALUES ('legacy-rollback', 'unit-1', '{"status":"planned"}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run();

    // Colisión deliberada: un ÍNDICE con el nombre de la tabla de migración
    // fuerza el fallo del CREATE TABLE dentro de la transacción.
    rollbackDb.exec("CREATE INDEX security_audit_runs_migrated ON security_audit_units(run_id)");
    assert.throws(
      () => initializeSecurityAuditSchema(rollbackDb),
      /already exists|already/i,
      "la colisión de nombre rompe la reconstrucción",
    );

    // 1) La tabla y la fila legadas quedan EXACTAMENTE como estaban.
    const row = rollbackDb
      .prepare(
        "SELECT run_status, incomplete_reason, output_dir FROM security_audit_runs WHERE run_id = 'legacy-rollback'",
      )
      .get() as { run_status: string; incomplete_reason: string; output_dir: string };
    assert.ok(row, "la fila legada sobrevive al rollback");
    assert.equal(row.run_status, "incomplete");
    assert.equal(row.incomplete_reason, "critic_budget_exhausted");
    assert.equal(row.output_dir, "/tmp/rollback-out");
    // 2) Sin tabla migrada huérfana.
    const leftover = rollbackDb
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'security_audit_runs_migrated'")
      .get();
    assert.equal(leftover, undefined, "no queda ninguna tabla migrada huérfana");
    // 3) La tabla legada conserva su CHECK antiguo (sin migración a medias).
    const legacySql = (rollbackDb
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'security_audit_runs'")
      .get() as { sql: string }).sql;
    assert.equal(legacySql.includes("execution_interrupted"), false);
    // 4) foreign_keys queda activado tras la restauración del pragma.
    assert.equal(
      ((rollbackDb.prepare("PRAGMA foreign_keys").get() ?? {}) as { foreign_keys?: number }).foreign_keys,
      1,
      "el pragma foreign_keys se restaura",
    );
    // 5) La integridad referencial sigue viva: hija sin padre se rechaza.
    assert.throws(
      () =>
        rollbackDb
          .prepare(
            `INSERT INTO security_audit_units (run_id, unit_id, payload_json, created_at, updated_at)
             VALUES ('sin-padre', 'u', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
          )
          .run(),
      /FOREIGN KEY|constraint/i,
    );

    // Retirada la colisión, la migración tiene éxito y es idempotente.
    rollbackDb.exec("DROP INDEX security_audit_runs_migrated");
    initializeSecurityAuditSchema(rollbackDb);
    initializeSecurityAuditSchema(rollbackDb);
    const migratedSql = (rollbackDb
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'security_audit_runs'")
      .get() as { sql: string }).sql;
    assert.ok(migratedSql.includes("execution_interrupted"), "el CHECK nuevo está activo");
    assert.deepEqual(
      rollbackDb.prepare("PRAGMA foreign_key_check").all(),
      [],
      "sin violaciones de integridad tras el reintento",
    );
    const migrated = rollbackDb
      .prepare(
        "SELECT run_status, incomplete_reason FROM security_audit_runs WHERE run_id = 'legacy-rollback'",
      )
      .get() as { run_status: string; incomplete_reason: string };
    assert.equal(migrated.run_status, "incomplete");
    assert.equal(migrated.incomplete_reason, "critic_budget_exhausted");
    const child = rollbackDb
      .prepare("SELECT unit_id FROM security_audit_units WHERE run_id = 'legacy-rollback'")
      .all() as unknown as Array<{ unit_id: string }>;
    assert.deepEqual(child.map((entry) => entry.unit_id), ["unit-1"], "la fila hija sigue viva");
  } finally {
    rollbackDb.close();
    rmSync(rollbackDir, { recursive: true, force: true });
  }
});

/**
 * Migración aditiva F06 sobre `security_audit_invocations`: una base creada
 * antes de la evidencia cross-engine (sin `fingerprint`,
 * `cross_engine_planned` ni `cross_engine_evidence_json`) se amplía sin perder
 * filas, con el veredicto real a 0 y la evidencia registrable a continuación.
 */
test("legacy invocations gain fingerprint/planned/evidence columns without losing rows", () => {
  const legacyDir = mkdtempSync(join(tmpdir(), "factory-security-audit-migration-invocations-"));
  const legacyDb = new DatabaseSync(join(legacyDir, "legacy-invocations.sqlite"));
  try {
    legacyDb.exec(LEGACY_RUNS_TABLE);
    legacyDb.exec(`
      CREATE TABLE security_audit_invocations (
        instance_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES security_audit_runs(run_id) ON DELETE CASCADE,
        phase INTEGER NOT NULL CHECK (phase BETWEEN 1 AND 6),
        role TEXT NOT NULL,
        agent_id TEXT,
        engine TEXT,
        model TEXT,
        session_id TEXT,
        agent_run_id TEXT,
        handoff_id TEXT,
        discoverer_instance_id TEXT
          REFERENCES security_audit_invocations(instance_id) ON DELETE SET NULL,
        verification_kind TEXT CHECK (
          verification_kind IS NULL OR verification_kind IN ('recon', 'hunter', 'critic', 'phase3', 'phase5')
        ),
        outcome TEXT NOT NULL DEFAULT 'running'
          CHECK (outcome IN ('running', 'succeeded', 'failed', 'cancelled')),
        provider_error_kind TEXT,
        provider_status INTEGER,
        auto_replay INTEGER NOT NULL DEFAULT 0 CHECK (auto_replay = 0),
        cross_engine INTEGER NOT NULL DEFAULT 0 CHECK (cross_engine IN (0, 1)),
        started_at TEXT NOT NULL,
        finished_at TEXT,
        CHECK (outcome = 'running' OR finished_at IS NOT NULL)
      )
    `);
    legacyDb.prepare(
      `INSERT INTO security_audit_runs
         (run_id, project_path, profile, intent, scope_json, output_dir, created_at, updated_at)
       VALUES ('legacy-inv', '/srv/legacy-inv', 'standard', 'full_audit', '{"kind":"project"}',
               '/tmp/legacy-inv', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run();
    legacyDb.prepare(
      `INSERT INTO security_audit_invocations
         (instance_id, run_id, phase, role, agent_id, engine, session_id, agent_run_id,
          handoff_id, verification_kind, outcome, cross_engine, started_at, finished_at)
       VALUES ('inv-legacy', 'legacy-inv', 3, 'candidate-verifier', 'reviewer', 'claude',
               'ses-legacy', 'agent-run-legacy', 'HANDOFF-REVIEWER-LEGACY', 'phase3',
               'succeeded', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z')`,
    ).run();

    initializeSecurityAuditSchema(legacyDb);
    initializeSecurityAuditSchema(legacyDb); // idempotente

    const columns = (
      legacyDb.prepare("PRAGMA table_info(security_audit_invocations)").all() as Array<{ name: string }>
    ).map((column) => column.name);
    for (const required of ["fingerprint", "cross_engine_planned", "cross_engine_evidence_json"]) {
      assert.ok(columns.includes(required), `la migración añade ${required}`);
    }

    // La fila legada sobrevive y el veredicto real pasa a interpretarse como
    // verificación planificada→evidencia ausente (nunca un éxito forzado).
    const [row] = listSecurityAuditInvocations(legacyDb, "legacy-inv");
    assert.ok(row, "la fila legada se conserva");
    assert.equal(row.instanceId, "inv-legacy");
    assert.equal(row.fingerprint, null);
    assert.equal(row.crossEngineEvidence, null);
    assert.equal(row.crossEnginePlanned, false);
    assert.equal(row.crossEngineVerified, false, "sin evidencia el veredicto real es false");

    // La evidencia es registrable sobre la fila migrada.
    recordSecurityAuditCrossEngineEvidence(legacyDb, "inv-legacy", {
      fingerprint: "fp-legacy",
      planned: true,
      verified: true,
      reason: null,
      discoverer: {
        instanceId: "inv-legacy-hunter",
        sessionId: "ses-hunter",
        engine: "opencode",
        model: "opencode-go/mimo-v2.6-flash",
        handoffId: "HANDOFF-REVERSE-LEGACY",
        agentRunId: "agent-run-hunter",
      },
      verifier: {
        instanceId: "inv-legacy",
        sessionId: "ses-legacy",
        engine: "claude",
        model: null,
        handoffId: "HANDOFF-REVIEWER-LEGACY",
        agentRunId: "agent-run-legacy",
      },
      verifiedAt: "2026-01-01T00:02:00.000Z",
    });
    const [verified] = listSecurityAuditInvocations(legacyDb, "legacy-inv");
    assert.equal(verified?.crossEngineVerified, true);
    assert.equal(verified?.crossEngineEvidence?.fingerprint, "fp-legacy");
    assert.deepEqual(
      legacyDb.prepare("PRAGMA foreign_key_check").all(),
      [],
      "sin violaciones de integridad tras la migración aditiva",
    );
  } finally {
    legacyDb.close();
    rmSync(legacyDir, { recursive: true, force: true });
  }
});

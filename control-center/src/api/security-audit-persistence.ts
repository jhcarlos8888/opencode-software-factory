/**
 * Persistencia SQLite de los runs `security-audit` sobre `node:sqlite`.
 *
 * Los archivos oficiales (`coverage-ledger.json`, `findings.json`,
 * `run-metadata.json`…) siguen siendo la fuente canónica del run; estas tablas
 * son un ÍNDICE de recuperación, reanudación y auditoría. La reconciliación
 * `reconcileSecurityAuditRun` compara ambos mundos y reporta discrepancias en
 * lugar de decidir cuál manda.
 *
 * `initializeSecurityAuditSchema(db)` es idempotente y segura para una base
 * preexistente: usa `CREATE TABLE IF NOT EXISTS`/`CREATE INDEX IF NOT EXISTS`
 * y no toca ninguna tabla ajena. `database.ts` la llama una sola vez tras su
 * esquema actual.
 *
 * Restricciones relevantes:
 * - `severity` solo en `confirmed` (CHECK de tabla).
 * - `incomplete_reason` obligatorio ⇔ `run_status = 'incomplete'`, y solo los
 *   cuatro motivos oficiales.
 * - `verified_fixed` exige evidencia no vacía (CHECK sobre `evidence_json`).
 * - `security_audit_invocations.auto_replay` es siempre 0: un 429 se clasifica
 *   pero nunca se reenvía el prompt automáticamente.
 * - Cada invocación tiene `instance_id` único y `outcome = 'running'` exige
 *   `started_at` (y todo estado terminal exige `finished_at`).
 */

import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  SECURITY_AUDIT_INCOMPLETE_REASONS,
  type SecurityAuditIncompleteReason,
} from "./security-audit-contracts.js";
// Paquete 2: el tipo del cluster de consolidación y su validador campo a
// campo viven en el módulo puro (sin DB); aquí solo se hidratan.
import { parseConsolidationCluster, type ConsolidationCluster } from "./security-audit-consolidation.js";

export type SecurityAuditPhaseState = "pending" | "in_progress" | "complete" | "skipped";
export type SecurityAuditRunStatus = "in_progress" | "complete" | "incomplete";
export type SecurityAuditValidatorState = "pending" | "pass" | "fail";
export type SecurityAuditUnitStatus =
  | "planned"
  | "not_applicable"
  | "out_of_scope"
  | "in_progress"
  | "covered"
  | "candidate"
  | "blocked"
  | "deferred";
export type SecurityAuditInvocationOutcome =
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";
export type SecurityAuditVerificationKind =
  | "recon"
  | "hunter"
  | "critic"
  | "phase3"
  | "phase5";
export type SecurityAuditFindingVerdict = "confirmed" | "needs_validation" | "rejected";
export type SecurityAuditSeverity =
  | "critical"
  | "high"
  | "medium"
  | "low"
  | "informational";
export type SecurityAuditRemediationState =
  | "requested"
  | "in_progress"
  | "revalidated"
  | "verified_fixed"
  | "rejected";

/** Motivos admitidos para `run_status = 'incomplete'` (unificación con contratos). */
const INCOMPLETE_REASONS: readonly SecurityAuditIncompleteReason[] = SECURITY_AUDIT_INCOMPLETE_REASONS;

const PHASE_STATES: readonly SecurityAuditPhaseState[] = [
  "pending",
  "in_progress",
  "complete",
  "skipped",
];

const UNIT_STATUSES: readonly SecurityAuditUnitStatus[] = [
  "planned",
  "not_applicable",
  "out_of_scope",
  "in_progress",
  "covered",
  "candidate",
  "blocked",
  "deferred",
];

const VERDICTS: readonly SecurityAuditFindingVerdict[] = [
  "confirmed",
  "needs_validation",
  "rejected",
];

const SEVERITIES: readonly SecurityAuditSeverity[] = [
  "critical",
  "high",
  "medium",
  "low",
  "informational",
];

const REMEDIATION_STATES: readonly SecurityAuditRemediationState[] = [
  "requested",
  "in_progress",
  "revalidated",
  "verified_fixed",
  "rejected",
];

function assertOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`${field} inválido: ${JSON.stringify(value)}`);
  }
  return value as T;
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function now(): string {
  return new Date().toISOString();
}

/**
 * DDL canónico de `security_audit_runs`, incluido el CHECK de motivos
 * incompletos con los seis motivos operativos además de los cuatro
 * oficiales de presupuesto. Se usa en la creación y en la reconstrucción
 * de la migración para que ambas rutas compartan exactamente el mismo CHECK.
 */
function securityAuditRunsTableSql(tableName: string, ifNotExists: boolean): string {
  return `CREATE TABLE ${ifNotExists ? "IF NOT EXISTS " : ""}${tableName} (
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
          'validation_budget_exhausted',
          'validator_failed',
          'orchestrator_failed',
          'provider_unavailable',
          'cancelled_by_user',
          'deadline_exceeded',
          'execution_interrupted'
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
    );`;
}

/**
 * Reconstruye `security_audit_runs` cuando la tabla se creó con el CHECK
 * antiguo de solo los cuatro motivos de presupuesto (no admite los motivos
 * operativos de cierre terminal).
 *
 * Garantías:
 * - Conserva todas las filas y las columnas que la tabla antigua tuviera
 *   (incluidas las añadidas por migraciones aditivas ajenas).
 * - Conserva los índices existentes sobre la tabla.
 * - Desactiva SOLO `foreign_keys` durante el intercambio para que el DROP no
 *   dispare en cascada sobre `security_audit_units`/`invocations`/…; los CHECK
 *   nunca se ignoran (`ignore_check_constraints` no se usa jamás).
 * - Tras reconstruir exige `PRAGMA foreign_key_check` sin violaciones.
 * - Idempotente: si el esquema ya incluye los motivos operativos, no hace nada.
 */
function rebuildSecurityAuditRunsIfLegacy(db: DatabaseSync): void {
  const tableRow = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'security_audit_runs'")
    .get() as { sql: string | null } | undefined;
  // Detección: el CHECK nuevo menciona `execution_interrupted`; el legado no.
  if (!tableRow?.sql || tableRow.sql.includes("'execution_interrupted'")) return;

  const oldColumns = db.prepare("PRAGMA table_info(security_audit_runs)").all() as Array<{
    name: string;
    type: string;
  }>;
  const indexes = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'security_audit_runs' AND sql IS NOT NULL",
    )
    .all() as Array<{ sql: string }>;
  const foreignKeysWereOn = ((db.prepare("PRAGMA foreign_keys").get() ?? {}) as {
    foreign_keys?: number;
  }).foreign_keys === 1;

  // Restos de un intento previo interrumpido: la reconstrucción es atómica,
  // así que una tabla huérfana solo puede existir si algo la creó fuera de
  // la transacción; se limpia antes de empezar.
  db.exec("DROP TABLE IF EXISTS security_audit_runs_migrated");
  // `PRAGMA foreign_keys` es inoperante dentro de una transacción: se cambia
  // ANTES de BEGIN. Los CHECK nunca se ignoran (no se usa
  // `ignore_check_constraints`).
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(securityAuditRunsTableSql("security_audit_runs_migrated", false));
      const newNames = new Set(
        (db.prepare("PRAGMA table_info(security_audit_runs_migrated)").all() as Array<{ name: string }>)
          .map((column) => column.name),
      );
      // Columnas presentes en la base antigua pero no en el canónico se añaden
      // para no perder datos de migraciones aditivas ajenas.
      for (const column of oldColumns) {
        if (!newNames.has(column.name)) {
          db.exec(
            `ALTER TABLE security_audit_runs_migrated ADD COLUMN "${column.name}" ${column.type || "TEXT"}`,
          );
        }
      }
      const copyColumns = oldColumns.map((column) => `"${column.name}"`).join(", ");
      db.exec(
        `INSERT INTO security_audit_runs_migrated (${copyColumns}) SELECT ${copyColumns} FROM security_audit_runs`,
      );
      db.exec("DROP TABLE security_audit_runs");
      db.exec("ALTER TABLE security_audit_runs_migrated RENAME TO security_audit_runs");
      for (const index of indexes) db.exec(index.sql);
      const violations = db.prepare("PRAGMA foreign_key_check").all();
      if (violations.length > 0) {
        throw new Error(
          `foreign_key_check encontró ${violations.length} referencia(s) inválida(s) tras reconstruir security_audit_runs`,
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      // Rollback completo: la tabla legada, sus filas y sus índices quedan
      // intactos si cualquier paso (copiado, renombrado, índices o
      // foreign_key_check) falla.
      try {
        db.exec("ROLLBACK");
      } catch {
        /* sin transacción activa que deshacer */
      }
      throw error;
    }
  } finally {
    db.exec(foreignKeysWereOn ? "PRAGMA foreign_keys = ON" : "PRAGMA foreign_keys = OFF");
  }
}

/** Crea (o comprueba) el esquema de auditorías; idempotente y aditivo. */
export function initializeSecurityAuditSchema(db: DatabaseSync): void {
  db.exec(`
    PRAGMA foreign_keys = ON;

    ${securityAuditRunsTableSql("security_audit_runs", true)}

    CREATE TABLE IF NOT EXISTS security_audit_units (
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
    );
    CREATE INDEX IF NOT EXISTS idx_security_audit_units_status
      ON security_audit_units(run_id, status);

    CREATE TABLE IF NOT EXISTS security_audit_invocations (
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
      fingerprint TEXT,
      cross_engine_planned INTEGER NOT NULL DEFAULT 0 CHECK (cross_engine_planned IN (0, 1)),
      cross_engine_evidence_json TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      CHECK (outcome = 'running' OR finished_at IS NOT NULL)
    );
    CREATE INDEX IF NOT EXISTS idx_security_audit_invocations_run
      ON security_audit_invocations(run_id, phase, verification_kind);

    CREATE TABLE IF NOT EXISTS security_audit_usage (
      instance_id TEXT PRIMARY KEY REFERENCES security_audit_invocations(instance_id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      usage_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS security_audit_findings (
      run_id TEXT NOT NULL REFERENCES security_audit_runs(run_id) ON DELETE CASCADE,
      fingerprint TEXT NOT NULL,
      verdict TEXT NOT NULL CHECK (verdict IN ('confirmed', 'needs_validation', 'rejected')),
      severity TEXT CHECK (severity IS NULL OR severity IN ('critical', 'high', 'medium', 'low', 'informational')),
      payload_json TEXT NOT NULL,
      source_refs_json TEXT NOT NULL DEFAULT '[]',
      verification_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (run_id, fingerprint),
      CHECK (verdict = 'confirmed' OR severity IS NULL)
    );
    CREATE INDEX IF NOT EXISTS idx_security_audit_findings_verdict
      ON security_audit_findings(run_id, verdict);

    -- F07: historial APPEND-ONLY de hallazgos. Solo INSERTs (nunca UPDATE ni
    -- DELETE desde el código de la fábrica); conserva el estado previo de cada
    -- reemplazo y de cada retiro (con su razón) tras eliminar la fila de la
    -- proyección activa. La tabla security_audit_findings es la proyección
    -- EXACTA del findings.json publicado: un registro retirado desaparece de
    -- aquí SOLO después de dejar su copia completa en el historial.
    CREATE TABLE IF NOT EXISTS security_audit_findings_history (
      history_id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES security_audit_runs(run_id) ON DELETE CASCADE,
      fingerprint TEXT NOT NULL,
      verdict TEXT NOT NULL CHECK (verdict IN ('confirmed', 'needs_validation', 'rejected')),
      severity TEXT CHECK (severity IS NULL OR severity IN ('critical', 'high', 'medium', 'low', 'informational')),
      payload_json TEXT NOT NULL,
      verification_json TEXT NOT NULL DEFAULT '[]',
      retirement_reason TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_security_audit_findings_history
      ON security_audit_findings_history(run_id, fingerprint);

    CREATE TABLE IF NOT EXISTS security_audit_checkpoints (
      run_id TEXT NOT NULL REFERENCES security_audit_runs(run_id) ON DELETE CASCADE,
      phase INTEGER NOT NULL CHECK (phase BETWEEN 1 AND 6),
      state TEXT NOT NULL CHECK (state IN ('pending', 'in_progress', 'complete', 'failed')),
      payload_json TEXT NOT NULL DEFAULT '{}',
      payload_sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (run_id, phase)
    );

    CREATE TABLE IF NOT EXISTS security_audit_work_state (
      run_id TEXT NOT NULL REFERENCES security_audit_runs(run_id) ON DELETE CASCADE,
      state_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (run_id)
    );

    CREATE TABLE IF NOT EXISTS security_audit_remediations (
      run_id TEXT NOT NULL REFERENCES security_audit_runs(run_id) ON DELETE CASCADE,
      fingerprint TEXT NOT NULL,
      execution_run_id TEXT REFERENCES execution_runs(id) ON DELETE SET NULL,
      state TEXT NOT NULL DEFAULT 'requested'
        CHECK (state IN ('requested', 'in_progress', 'revalidated', 'verified_fixed', 'rejected')),
      evidence_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      PRIMARY KEY (run_id, fingerprint),
      CHECK (state <> 'verified_fixed' OR evidence_json NOT IN ('[]', ''))
    );
    CREATE INDEX IF NOT EXISTS idx_security_audit_remediations_state
      ON security_audit_remediations(run_id, state);
  `);

  // Migración aditiva para bases creadas antes de la verificación cruzada y
  // del agente por instancia.
  const invocationColumns = db.prepare("PRAGMA table_info(security_audit_invocations)").all() as Array<{
    name: string;
  }>;
  if (!invocationColumns.some((column) => column.name === "cross_engine")) {
    db.exec(
      "ALTER TABLE security_audit_invocations ADD COLUMN cross_engine INTEGER NOT NULL DEFAULT 0 " +
        "CHECK (cross_engine IN (0, 1))",
    );
  }
  if (!invocationColumns.some((column) => column.name === "agent_id")) {
    db.exec("ALTER TABLE security_audit_invocations ADD COLUMN agent_id TEXT");
  }
  // Migración aditiva F06: la huella verificada, la intención de plan y la
  // evidencia estructurada de verificación cruzada. `cross_engine` pasa a ser
  // SOLO el veredicto real (0 hasta que el orquestador registra evidencia).
  if (!invocationColumns.some((column) => column.name === "fingerprint")) {
    db.exec("ALTER TABLE security_audit_invocations ADD COLUMN fingerprint TEXT");
  }
  if (!invocationColumns.some((column) => column.name === "cross_engine_planned")) {
    db.exec(
      "ALTER TABLE security_audit_invocations ADD COLUMN cross_engine_planned INTEGER NOT NULL DEFAULT 0 " +
        "CHECK (cross_engine_planned IN (0, 1))",
    );
  }
  if (!invocationColumns.some((column) => column.name === "cross_engine_evidence_json")) {
    db.exec("ALTER TABLE security_audit_invocations ADD COLUMN cross_engine_evidence_json TEXT");
  }
  // Normalización F06: en el esquema antiguo `cross_engine = 1` solo señalaba
  // la asignación preferida (plan). Sin evidencia estructurada registrada, el
  // veredicto real pasa a 0: nunca se hereda un éxito sin evidencia.
  db.exec(
    "UPDATE security_audit_invocations SET cross_engine = 0 " +
      "WHERE cross_engine = 1 AND cross_engine_evidence_json IS NULL",
  );

  // Migración de reconstrucción para bases creadas con el CHECK antiguo de
  // solo cuatro motivos de presupuesto (idempotente; ver comentarios).
  rebuildSecurityAuditRunsIfLegacy(db);
}

export interface SecurityAuditRunInput {
  runId: string;
  projectPath: string;
  sourceRef?: string | null;
  sourceDirty?: boolean;
  profile: "quick" | "standard" | "deep";
  intent: "guidance" | "full_audit" | "remediation";
  scope?: unknown;
  budgetConfig?: unknown;
  budgetSpent?: unknown;
  budgetReserved?: unknown;
  maxConcurrency?: number;
  maxDurationMs?: number | null;
  outputDir: string;
  executionPolicy?: "source-only" | "sandboxed-source-and-local-only";
  sandboxStatus?: "source_only" | "sandboxed" | "unavailable";
  sandboxEvidence?: unknown[];
  sandboxBlockers?: string[];
}

export interface SecurityAuditRunRow {
  runId: string;
  projectPath: string;
  sourceRef: string | null;
  sourceDirty: boolean;
  profile: "quick" | "standard" | "deep";
  intent: "guidance" | "full_audit" | "remediation";
  scope: unknown;
  budgetConfig: unknown;
  budgetSpent: unknown;
  budgetReserved: unknown;
  maxConcurrency: number;
  maxDurationMs: number | null;
  phases: SecurityAuditPhaseState[];
  runStatus: SecurityAuditRunStatus;
  incompleteReason: SecurityAuditIncompleteReason | null;
  outputDir: string;
  executionPolicy: "source-only" | "sandboxed-source-and-local-only";
  sandboxStatus: "source_only" | "sandboxed" | "unavailable";
  sandboxEvidence: unknown[];
  sandboxBlockers: string[];
  ledgerValidator: SecurityAuditValidatorState;
  findingsValidator: SecurityAuditValidatorState;
  cancelRequested: boolean;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

interface RawRunRow {
  run_id: string;
  project_path: string;
  source_ref: string | null;
  source_dirty: number;
  profile: SecurityAuditRunRow["profile"];
  intent: SecurityAuditRunRow["intent"];
  scope_json: string;
  budget_config_json: string;
  budget_spent_json: string;
  budget_reserved_json: string;
  max_concurrency: number;
  max_duration_ms: number | null;
  phase_1: SecurityAuditPhaseState;
  phase_2: SecurityAuditPhaseState;
  phase_3: SecurityAuditPhaseState;
  phase_4: SecurityAuditPhaseState;
  phase_5: SecurityAuditPhaseState;
  phase_6: SecurityAuditPhaseState;
  run_status: SecurityAuditRunStatus;
  incomplete_reason: SecurityAuditIncompleteReason | null;
  output_dir: string;
  execution_policy: SecurityAuditRunRow["executionPolicy"];
  sandbox_status: SecurityAuditRunRow["sandboxStatus"];
  sandbox_evidence_json: string;
  sandbox_blockers_json: string;
  ledger_validator: SecurityAuditValidatorState;
  findings_validator: SecurityAuditValidatorState;
  cancel_requested: number;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

function mapRun(row: RawRunRow): SecurityAuditRunRow {
  return {
    runId: row.run_id,
    projectPath: row.project_path,
    sourceRef: row.source_ref,
    sourceDirty: row.source_dirty === 1,
    profile: row.profile,
    intent: row.intent,
    scope: parseJson<unknown>(row.scope_json, {}),
    budgetConfig: parseJson<unknown>(row.budget_config_json, {}),
    budgetSpent: parseJson<unknown>(row.budget_spent_json, {}),
    budgetReserved: parseJson<unknown>(row.budget_reserved_json, {}),
    maxConcurrency: row.max_concurrency,
    maxDurationMs: row.max_duration_ms,
    phases: [row.phase_1, row.phase_2, row.phase_3, row.phase_4, row.phase_5, row.phase_6],
    runStatus: row.run_status,
    incompleteReason: row.incomplete_reason,
    outputDir: row.output_dir,
    executionPolicy: row.execution_policy,
    sandboxStatus: row.sandbox_status,
    sandboxEvidence: parseJson<unknown[]>(row.sandbox_evidence_json, []),
    sandboxBlockers: parseJson<string[]>(row.sandbox_blockers_json, []),
    ledgerValidator: row.ledger_validator,
    findingsValidator: row.findings_validator,
    cancelRequested: row.cancel_requested === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

const RUN_COLUMNS = `run_id, project_path, source_ref, source_dirty, profile, intent,
  scope_json, budget_config_json, budget_spent_json, budget_reserved_json,
  max_concurrency, max_duration_ms, phase_1, phase_2, phase_3, phase_4, phase_5,
  phase_6, run_status, incomplete_reason, output_dir, execution_policy,
  sandbox_status, sandbox_evidence_json, sandbox_blockers_json, ledger_validator,
  findings_validator, cancel_requested, created_at, updated_at, finished_at`;

export function createSecurityAuditRun(
  db: DatabaseSync,
  input: SecurityAuditRunInput,
): SecurityAuditRunRow {
  const maxConcurrency = input.maxConcurrency ?? 1;
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new Error("maxConcurrency debe ser un entero >= 1");
  }
  const timestamp = now();
  db.prepare(`
    INSERT INTO security_audit_runs (
      run_id, project_path, source_ref, source_dirty, profile, intent,
      scope_json, budget_config_json, budget_spent_json, budget_reserved_json,
      max_concurrency, max_duration_ms, output_dir, execution_policy,
      sandbox_status, sandbox_evidence_json, sandbox_blockers_json,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.runId,
    input.projectPath,
    input.sourceRef ?? null,
    input.sourceDirty ? 1 : 0,
    input.profile,
    input.intent,
    json(input.scope ?? {}),
    json(input.budgetConfig ?? {}),
    json(input.budgetSpent ?? {}),
    json(input.budgetReserved ?? {}),
    maxConcurrency,
    input.maxDurationMs ?? null,
    input.outputDir,
    input.executionPolicy ?? "source-only",
    input.sandboxStatus ?? "source_only",
    json(input.sandboxEvidence ?? []),
    json(input.sandboxBlockers ?? []),
    timestamp,
    timestamp,
  );
  const created = getSecurityAuditRun(db, input.runId);
  if (!created) throw new Error("no se pudo crear el run de auditoría");
  return created;
}

export function getSecurityAuditRun(
  db: DatabaseSync,
  runId: string,
): SecurityAuditRunRow | null {
  const row = db
    .prepare(`SELECT ${RUN_COLUMNS} FROM security_audit_runs WHERE run_id = ?`)
    .get(runId) as RawRunRow | undefined;
  return row ? mapRun(row) : null;
}

export function listSecurityAuditRuns(db: DatabaseSync): SecurityAuditRunRow[] {
  const rows = db
    .prepare(`SELECT ${RUN_COLUMNS} FROM security_audit_runs ORDER BY created_at, run_id`)
    .all() as unknown as RawRunRow[];
  return rows.map(mapRun);
}

export function setSecurityAuditPhase(
  db: DatabaseSync,
  runId: string,
  phase: number,
  state: SecurityAuditPhaseState,
): void {
  if (!Number.isInteger(phase) || phase < 1 || phase > 6) {
    throw new Error(`fase inválida: ${phase}`);
  }
  assertOneOf(state, PHASE_STATES, "state");
  const info = db
    .prepare(
      `UPDATE security_audit_runs SET phase_${phase} = ?, updated_at = ? WHERE run_id = ?`,
    )
    .run(state, now(), runId);
  if (Number(info.changes) === 0) throw new Error(`run no encontrado: ${runId}`);
}

export function updateSecurityAuditRunStatus(
  db: DatabaseSync,
  runId: string,
  status: SecurityAuditRunStatus,
  reason: SecurityAuditIncompleteReason | null = null,
): void {
  if (status === "incomplete") {
    assertOneOf(reason, INCOMPLETE_REASONS, "incomplete_reason");
  } else if (reason !== null) {
    throw new Error("solo incomplete admite incomplete_reason");
  }
  const timestamp = now();
  const finishedAt = status === "in_progress" ? null : timestamp;
  const info = db
    .prepare(
      `UPDATE security_audit_runs
         SET run_status = ?, incomplete_reason = ?, updated_at = ?,
             finished_at = ?
       WHERE run_id = ?`,
    )
    .run(status, reason, timestamp, finishedAt, runId);
  if (Number(info.changes) === 0) throw new Error(`run no encontrado: ${runId}`);
}

/** Actualiza gasto y reservas de presupuesto del run (evidencia del ledger). */
export function updateSecurityAuditBudget(
  db: DatabaseSync,
  runId: string,
  input: { spent?: unknown; reserved?: unknown; config?: unknown },
): void {
  const timestamp = now();
  if (input.spent !== undefined) {
    db.prepare(
      "UPDATE security_audit_runs SET budget_spent_json = ?, updated_at = ? WHERE run_id = ?",
    ).run(json(input.spent), timestamp, runId);
  }
  if (input.reserved !== undefined) {
    db.prepare(
      "UPDATE security_audit_runs SET budget_reserved_json = ?, updated_at = ? WHERE run_id = ?",
    ).run(json(input.reserved), timestamp, runId);
  }
  if (input.config !== undefined) {
    db.prepare(
      "UPDATE security_audit_runs SET budget_config_json = ?, updated_at = ? WHERE run_id = ?",
    ).run(json(input.config), timestamp, runId);
  }
}

export function setSecurityAuditValidators(
  db: DatabaseSync,
  runId: string,
  input: { ledger?: SecurityAuditValidatorState; findings?: SecurityAuditValidatorState },
): void {
  const timestamp = now();
  if (input.ledger) {
    assertOneOf(input.ledger, ["pending", "pass", "fail"], "ledger_validator");
    db.prepare(
      "UPDATE security_audit_runs SET ledger_validator = ?, updated_at = ? WHERE run_id = ?",
    ).run(input.ledger, timestamp, runId);
  }
  if (input.findings) {
    assertOneOf(input.findings, ["pending", "pass", "fail"], "findings_validator");
    db.prepare(
      "UPDATE security_audit_runs SET findings_validator = ?, updated_at = ? WHERE run_id = ?",
    ).run(input.findings, timestamp, runId);
  }
}

export function setSecurityAuditSandbox(
  db: DatabaseSync,
  runId: string,
  input: {
    executionPolicy?: "source-only" | "sandboxed-source-and-local-only";
    sandboxStatus?: "source_only" | "sandboxed" | "unavailable";
    evidence?: unknown[];
    blockers?: string[];
  },
): void {
  const timestamp = now();
  if (input.executionPolicy) {
    assertOneOf(
      input.executionPolicy,
      ["source-only", "sandboxed-source-and-local-only"],
      "execution_policy",
    );
    db.prepare(
      "UPDATE security_audit_runs SET execution_policy = ?, updated_at = ? WHERE run_id = ?",
    ).run(input.executionPolicy, timestamp, runId);
  }
  if (input.sandboxStatus) {
    assertOneOf(input.sandboxStatus, ["source_only", "sandboxed", "unavailable"], "sandbox_status");
    db.prepare(
      "UPDATE security_audit_runs SET sandbox_status = ?, updated_at = ? WHERE run_id = ?",
    ).run(input.sandboxStatus, timestamp, runId);
  }
  if (input.evidence) {
    db.prepare(
      "UPDATE security_audit_runs SET sandbox_evidence_json = ?, updated_at = ? WHERE run_id = ?",
    ).run(json(input.evidence), timestamp, runId);
  }
  if (input.blockers) {
    db.prepare(
      "UPDATE security_audit_runs SET sandbox_blockers_json = ?, updated_at = ? WHERE run_id = ?",
    ).run(json(input.blockers), timestamp, runId);
  }
}

export function requestSecurityAuditCancel(db: DatabaseSync, runId: string): boolean {
  const info = db
    .prepare(
      "UPDATE security_audit_runs SET cancel_requested = 1, updated_at = ? WHERE run_id = ?",
    )
    .run(now(), runId);
  return Number(info.changes) > 0;
}

export function clearSecurityAuditCancel(db: DatabaseSync, runId: string): void {
  db.prepare("UPDATE security_audit_runs SET cancel_requested = 0, updated_at = ? WHERE run_id = ?").run(now(), runId);
}

export function isSecurityAuditCancelRequested(db: DatabaseSync, runId: string): boolean {
  const row = db
    .prepare("SELECT cancel_requested FROM security_audit_runs WHERE run_id = ?")
    .get(runId) as { cancel_requested: number } | undefined;
  return row?.cancel_requested === 1;
}

export interface SecurityAuditUnitInput {
  unitId: string;
  coverageId?: string | null;
  wave?: number;
  status?: SecurityAuditUnitStatus;
  payload?: unknown;
}

export function upsertSecurityAuditUnits(
  db: DatabaseSync,
  runId: string,
  units: readonly SecurityAuditUnitInput[],
): void {
  if (units.length === 0) return;
  const timestamp = now();
  const statement = db.prepare(`
    INSERT INTO security_audit_units
      (run_id, unit_id, coverage_id, wave, status, payload_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id, unit_id) DO UPDATE SET
      coverage_id = excluded.coverage_id,
      wave = excluded.wave,
      status = excluded.status,
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at
  `);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const unit of units) {
      assertOneOf(unit.status ?? "planned", UNIT_STATUSES, "unit.status");
      statement.run(
        runId,
        unit.unitId,
        unit.coverageId ?? null,
        unit.wave ?? 0,
        unit.status ?? "planned",
        json(unit.payload ?? {}),
        timestamp,
        timestamp,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * F07: reconcilia la proyección de unidades con el `coverage-ledger.json`
 * oficial en UNA transacción: upsert de todas las unidades del archivo y
 * DELETE de las unidades stale que ya no figuran en él. Los intentos (attempts)
 * viven DENTRO de `payload_json` de cada unidad, así que las filas que siguen
 * activas los conservan intactos; las stale desaparecen con el archivo.
 */
export function reconcileSecurityAuditUnits(
  db: DatabaseSync,
  runId: string,
  units: readonly SecurityAuditUnitInput[],
): { removed: string[] } {
  const keep = new Set(units.map((unit) => unit.unitId));
  const timestamp = now();
  const statement = db.prepare(`
    INSERT INTO security_audit_units
      (run_id, unit_id, coverage_id, wave, status, payload_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id, unit_id) DO UPDATE SET
      coverage_id = excluded.coverage_id,
      wave = excluded.wave,
      status = excluded.status,
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at
  `);
  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = listSecurityAuditUnits(db, runId).map((unit) => unit.unitId);
    const removed = existing.filter((unitId) => !keep.has(unitId));
    const deleter = db.prepare(
      "DELETE FROM security_audit_units WHERE run_id = ? AND unit_id = ?",
    );
    for (const unitId of removed) deleter.run(runId, unitId);
    for (const unit of units) {
      assertOneOf(unit.status ?? "planned", UNIT_STATUSES, "unit.status");
      statement.run(
        runId,
        unit.unitId,
        unit.coverageId ?? null,
        unit.wave ?? 0,
        unit.status ?? "planned",
        json(unit.payload ?? {}),
        timestamp,
        timestamp,
      );
    }
    db.exec("COMMIT");
    return { removed };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export interface SecurityAuditUnitRow {
  unitId: string;
  coverageId: string | null;
  wave: number;
  status: SecurityAuditUnitStatus;
  payload: unknown;
}

export function listSecurityAuditUnits(
  db: DatabaseSync,
  runId: string,
): SecurityAuditUnitRow[] {
  const rows = db
    .prepare(
      `SELECT unit_id, coverage_id, wave, status, payload_json
         FROM security_audit_units WHERE run_id = ? ORDER BY unit_id`,
    )
    .all(runId) as unknown as Array<{
      unit_id: string;
      coverage_id: string | null;
      wave: number;
      status: SecurityAuditUnitStatus;
      payload_json: string;
    }>;
  return rows.map((row) => ({
    unitId: row.unit_id,
    coverageId: row.coverage_id,
    wave: row.wave,
    status: row.status,
    payload: parseJson<unknown>(row.payload_json, {}),
  }));
}

export interface SecurityAuditInvocationInput {
  instanceId: string;
  runId: string;
  phase: number;
  role: string;
  /** Agente de la fábrica que ejecuta la instancia (architect, reviewer…). */
  agentId?: string | null;
  engine?: string | null;
  model?: string | null;
  sessionId?: string | null;
  agentRunId?: string | null;
  handoffId?: string | null;
  discovererInstanceId?: string | null;
  verificationKind?: SecurityAuditVerificationKind | null;
  /** Huella cuya verificación corresponde a la instancia (fase 3/5); null en el resto. */
  fingerprint?: string | null;
  /**
   * SOLO la intención de plan (motor opuesto disponible antes de invocar).
   * El éxito real (`cross_engine`) nunca se registra aquí: inicia en 0 y solo
   * `recordSecurityAuditCrossEngineEvidence` lo afirma con evidencia.
   */
  crossEnginePlanned?: boolean;
}

export function recordSecurityAuditInvocation(
  db: DatabaseSync,
  input: SecurityAuditInvocationInput,
): void {
  if (!Number.isInteger(input.phase) || input.phase < 1 || input.phase > 6) {
    throw new Error(`fase inválida: ${input.phase}`);
  }
  if (input.verificationKind) {
    assertOneOf(
      input.verificationKind,
      ["recon", "hunter", "critic", "phase3", "phase5"],
      "verification_kind",
    );
  }
  db.prepare(`
    INSERT INTO security_audit_invocations (
      instance_id, run_id, phase, role, agent_id, engine, model, session_id, agent_run_id,
      handoff_id, discoverer_instance_id, verification_kind, fingerprint,
      cross_engine_planned, outcome, auto_replay, cross_engine, started_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', 0, 0, ?)
  `).run(
    input.instanceId,
    input.runId,
    input.phase,
    input.role,
    input.agentId ?? null,
    input.engine ?? null,
    input.model ?? null,
    input.sessionId ?? null,
    input.agentRunId ?? null,
    input.handoffId ?? null,
    input.discovererInstanceId ?? null,
    input.verificationKind ?? null,
    input.fingerprint ?? null,
    input.crossEnginePlanned ? 1 : 0,
    now(),
  );
}

export function finishSecurityAuditInvocation(
  db: DatabaseSync,
  instanceId: string,
  outcome: Exclude<SecurityAuditInvocationOutcome, "running">,
  providerError: { kind?: string | null; status?: number | null } = {},
): void {
  const info = db
    .prepare(
      `UPDATE security_audit_invocations
         SET outcome = ?, provider_error_kind = ?, provider_status = ?, finished_at = ?
       WHERE instance_id = ? AND outcome = 'running'`,
    )
    .run(
      outcome,
      providerError.kind ?? null,
      providerError.status ?? null,
      now(),
      instanceId,
    );
  if (Number(info.changes) === 0) {
    throw new Error(`invocación no abierta o inexistente: ${instanceId}`);
  }
}

export interface SecurityAuditInvocationRow {
  instanceId: string;
  phase: number;
  role: string;
  agentId: string | null;
  engine: string | null;
  model: string | null;
  sessionId: string | null;
  agentRunId: string | null;
  handoffId: string | null;
  discovererInstanceId: string | null;
  verificationKind: SecurityAuditVerificationKind | null;
  fingerprint: string | null;
  outcome: SecurityAuditInvocationOutcome;
  providerErrorKind: string | null;
  providerStatus: number | null;
  autoReplay: boolean;
  /** Veredicto REAL de verificación cruzada; false hasta que hay evidencia. */
  crossEngineVerified: boolean;
  /** Intención de plan registrada antes de invocar (nunca es un éxito). */
  crossEnginePlanned: boolean;
  crossEngineEvidence: SecurityAuditCrossEngineEvidence | null;
  startedAt: string;
  finishedAt: string | null;
}

export function listSecurityAuditInvocations(
  db: DatabaseSync,
  runId: string,
): SecurityAuditInvocationRow[] {
  const rows = db
    .prepare(
      `SELECT instance_id, phase, role, agent_id, engine, model, session_id, agent_run_id,
              handoff_id, discoverer_instance_id, verification_kind, fingerprint, outcome,
              provider_error_kind, provider_status, auto_replay, cross_engine,
              cross_engine_planned, cross_engine_evidence_json, started_at, finished_at
         FROM security_audit_invocations WHERE run_id = ? ORDER BY started_at, instance_id`,
    )
    .all(runId) as unknown as Array<{
      instance_id: string;
      phase: number;
      role: string;
      agent_id: string | null;
      engine: string | null;
      model: string | null;
      session_id: string | null;
      agent_run_id: string | null;
      handoff_id: string | null;
      discoverer_instance_id: string | null;
      verification_kind: SecurityAuditVerificationKind | null;
      fingerprint: string | null;
      outcome: SecurityAuditInvocationOutcome;
      provider_error_kind: string | null;
      provider_status: number | null;
      auto_replay: number;
      cross_engine: number;
      cross_engine_planned: number;
      cross_engine_evidence_json: string | null;
      started_at: string;
      finished_at: string | null;
    }>;
  return rows.map((row) => ({
    instanceId: row.instance_id,
    phase: row.phase,
    role: row.role,
    agentId: row.agent_id,
    engine: row.engine,
    model: row.model,
    sessionId: row.session_id,
    agentRunId: row.agent_run_id,
    handoffId: row.handoff_id,
    discovererInstanceId: row.discoverer_instance_id,
    verificationKind: row.verification_kind,
    fingerprint: row.fingerprint,
    outcome: row.outcome,
    providerErrorKind: row.provider_error_kind,
    providerStatus: row.provider_status,
    autoReplay: row.auto_replay === 1,
    crossEngineVerified: row.cross_engine === 1,
    crossEnginePlanned: row.cross_engine_planned === 1,
    crossEngineEvidence: row.cross_engine_evidence_json === null
      ? null
      : parseJson<SecurityAuditCrossEngineEvidence | null>(row.cross_engine_evidence_json, null),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  }));
}

export interface SecurityAuditCrossEngineParty {
  instanceId: string;
  sessionId: string | null;
  engine: string | null;
  model: string | null;
  handoffId: string | null;
  agentRunId: string | null;
}

/** Evidencia estructurada de una verificación cruzada (F06). */
export interface SecurityAuditCrossEngineEvidence {
  fingerprint: string;
  /** Huella del registro aceptado por el padre tras interpretar la respuesta. */
  acceptedRecordSha256?: string | null;
  /** Intención de plan registrada antes de invocar (nunca es un éxito). */
  planned: boolean;
  verified: boolean;
  /** Razón oficial cuando `verified` es false; null cuando es true. */
  reason: string | null;
  discoverer: SecurityAuditCrossEngineParty | null;
  verifier: SecurityAuditCrossEngineParty;
  /** Marca temporal del veredicto; null cuando no se verificó. */
  verifiedAt: string | null;
}

export function getSecurityAuditInvocation(
  db: DatabaseSync,
  runId: string,
  instanceId: string,
): SecurityAuditInvocationRow | null {
  const row = db
    .prepare(
      `SELECT instance_id, phase, role, agent_id, engine, model, session_id, agent_run_id,
              handoff_id, discoverer_instance_id, verification_kind, fingerprint, outcome,
              provider_error_kind, provider_status, auto_replay, cross_engine,
              cross_engine_planned, cross_engine_evidence_json, started_at, finished_at
          FROM security_audit_invocations WHERE run_id = ? AND instance_id = ?`,
    )
    .get(runId, instanceId) as unknown as {
      instance_id: string;
      phase: number;
      role: string;
      agent_id: string | null;
      engine: string | null;
      model: string | null;
      session_id: string | null;
      agent_run_id: string | null;
      handoff_id: string | null;
      discoverer_instance_id: string | null;
      verification_kind: SecurityAuditVerificationKind | null;
      fingerprint: string | null;
      outcome: SecurityAuditInvocationOutcome;
      provider_error_kind: string | null;
      provider_status: number | null;
      auto_replay: number;
      cross_engine: number;
      cross_engine_planned: number;
      cross_engine_evidence_json: string | null;
      started_at: string;
      finished_at: string | null;
    } | undefined;
  if (!row) return null;
  return {
    instanceId: row.instance_id,
    phase: row.phase,
    role: row.role,
    agentId: row.agent_id,
    engine: row.engine,
    model: row.model,
    sessionId: row.session_id,
    agentRunId: row.agent_run_id,
    handoffId: row.handoff_id,
    discovererInstanceId: row.discoverer_instance_id,
    verificationKind: row.verification_kind,
    fingerprint: row.fingerprint,
    outcome: row.outcome,
    providerErrorKind: row.provider_error_kind,
    providerStatus: row.provider_status,
    autoReplay: row.auto_replay === 1,
    crossEngineVerified: row.cross_engine === 1,
    crossEnginePlanned: row.cross_engine_planned === 1,
    crossEngineEvidence: row.cross_engine_evidence_json === null
      ? null
      : parseJson<SecurityAuditCrossEngineEvidence | null>(row.cross_engine_evidence_json, null),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

/**
 * F06: persiste la sesión REAL de una invocación (solo se conoce al terminar
 * la instancia). El registro inicial ocurre antes de crear la sesión.
 */
export function setSecurityAuditInvocationSession(
  db: DatabaseSync,
  instanceId: string,
  sessionId: string | null,
): void {
  const info = db
    .prepare("UPDATE security_audit_invocations SET session_id = ? WHERE instance_id = ?")
    .run(sessionId, instanceId);
  if (Number(info.changes) === 0) {
    throw new Error(`invocación inexistente para sesión: ${instanceId}`);
  }
}

/**
 * Registra la evidencia cross-engine REAL de una invocación (F06): el veredicto
 * `cross_engine` y la evidencia estructurada SOLO se escriben aquí, después de
 * interpretar la salida. Nunca se afirma éxito por asignación preferida.
 */
export function recordSecurityAuditCrossEngineEvidence(
  db: DatabaseSync,
  instanceId: string,
  evidence: SecurityAuditCrossEngineEvidence,
): void {
  const info = db
    .prepare(
      `UPDATE security_audit_invocations
          SET cross_engine = ?, cross_engine_evidence_json = ?
        WHERE instance_id = ?`,
    )
    .run(evidence.verified ? 1 : 0, json(evidence), instanceId);
  if (Number(info.changes) === 0) {
    throw new Error(`invocación inexistente para evidencia cross-engine: ${instanceId}`);
  }
}

export interface SecurityAuditFindingInput {
  fingerprint: string;
  verdict: SecurityAuditFindingVerdict;
  severity?: SecurityAuditSeverity | null;
  payload: unknown;
  sourceRefs?: unknown[];
  verificationHistory?: unknown[];
}

/**
 * Upsert de un hallazgo. La severidad solo sobrevive en `confirmed`; en los
 * demás veredictos se limpia (además del CHECK de tabla).
 */
export function upsertSecurityAuditFinding(
  db: DatabaseSync,
  runId: string,
  finding: SecurityAuditFindingInput,
): void {
  assertOneOf(finding.verdict, VERDICTS, "verdict");
  if (finding.severity) assertOneOf(finding.severity, SEVERITIES, "severity");
  const severity =
    finding.verdict === "confirmed" ? finding.severity ?? null : null;
  const timestamp = now();
  db.prepare(`
    INSERT INTO security_audit_findings
      (run_id, fingerprint, verdict, severity, payload_json, source_refs_json,
       verification_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id, fingerprint) DO UPDATE SET
      verdict = excluded.verdict,
      severity = excluded.severity,
      payload_json = excluded.payload_json,
      source_refs_json = excluded.source_refs_json,
      verification_json = excluded.verification_json,
      updated_at = excluded.updated_at
  `).run(
    runId,
    finding.fingerprint,
    finding.verdict,
    severity,
    json(finding.payload),
    json(finding.sourceRefs ?? []),
    json(finding.verificationHistory ?? []),
    timestamp,
    timestamp,
  );
}

export interface SecurityAuditFindingRow {
  fingerprint: string;
  verdict: SecurityAuditFindingVerdict;
  severity: SecurityAuditSeverity | null;
  payload: unknown;
  sourceRefs: unknown[];
  verificationHistory: unknown[];
}

export function listSecurityAuditFindings(
  db: DatabaseSync,
  runId: string,
): SecurityAuditFindingRow[] {
  const rows = db
    .prepare(
      `SELECT fingerprint, verdict, severity, payload_json, source_refs_json, verification_json
         FROM security_audit_findings WHERE run_id = ? ORDER BY fingerprint`,
    )
    .all(runId) as unknown as Array<{
      fingerprint: string;
      verdict: SecurityAuditFindingVerdict;
      severity: SecurityAuditSeverity | null;
      payload_json: string;
      source_refs_json: string;
      verification_json: string;
    }>;
  return rows.map((row) => ({
    fingerprint: row.fingerprint,
    verdict: row.verdict,
    severity: row.severity,
    payload: parseJson<unknown>(row.payload_json, null),
    sourceRefs: parseJson<unknown[]>(row.source_refs_json, []),
    verificationHistory: parseJson<unknown[]>(row.verification_json, []),
  }));
}

/** Razón de retiro de un registro retirado de la proyección (historial F07). */
export type SecurityAuditFindingRetirementReason =
  | "replacement"
  | "phase5_without_verifier"
  | "phase5_verifier_outcome_failed"
  | "phase5_verifier_not_independent"
  | "phase5_output_malformed"
  | "verification_fingerprint_mismatch"
  | "replacement_fingerprint_mismatch"
  | "verification_unverified"
  | "material_replacement_failed"
  | "unpublished_work_record_discarded"
  | "removed_from_findings_map";

export interface SecurityAuditFindingProjectionRecord {
  fingerprint: string;
  verdict: SecurityAuditFindingVerdict;
  severity: SecurityAuditSeverity | null;
  payload: unknown;
  /**
   * Historial de verificación ACTIVO del registro. `null`/`undefined`
   * conserva el `verification_json` de la fila existente: un reemplazo nunca
   * resetea el historial de verificación a `[]`.
   */
  verificationHistory?: unknown[] | null;
}

export interface SecurityAuditFindingsProjectionReconcileInput {
  /** Registros EXACTOS del `findings.json` publicado (proyección esperada). */
  records: ReadonlyArray<SecurityAuditFindingProjectionRecord>;
  /** Razón de retiro por fingerprint retirado de la proyección. */
  retirements?: ReadonlyMap<string, string>;
  /** Razón por omisión cuando el mapa no trae una entrada. */
  fallbackRetirementReason?: string;
}

export interface SecurityAuditFindingsProjectionReconcileReport {
  upserted: string[];
  retired: Array<{ fingerprint: string; reason: string }>;
}

/**
 * F07: reconcilia `security_audit_findings` con EXACTAMENTE los registros del
 * `findings.json` publicado (el llamador ya escribió y validó el artefacto).
 *
 * Garantías, en UNA transacción:
 * - Cada registro se upserta con su severidad (solo `confirmed`) y conserva el
 *   `verification_json` previo cuando no se declara uno nuevo.
 * - Un reemplazo (verdict/severity/payload cambian) guarda ANTES una fila del
 *   estado previo en el historial append-only con razón `replacement`.
 * - Un fingerprint que desaparece del artefacto se retira de la proyección
 *   SOLO tras insertar su copia completa en el historial con la razón de
 *   retiro declarada (mapa del orquestador o razón por omisión); JAMÁS se
 *   borra sin historial.
 */
export function reconcileSecurityAuditFindingsProjection(
  db: DatabaseSync,
  runId: string,
  input: SecurityAuditFindingsProjectionReconcileInput,
): SecurityAuditFindingsProjectionReconcileReport {
  const existingRows = listSecurityAuditFindings(db, runId);
  const existingByFingerprint = new Map(
    existingRows.map((row) => [row.fingerprint, row]),
  );
  const keep = new Set(input.records.map((record) => record.fingerprint));
  const timestamp = now();
  const upsert = db.prepare(`
    INSERT INTO security_audit_findings
      (run_id, fingerprint, verdict, severity, payload_json, source_refs_json,
       verification_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id, fingerprint) DO UPDATE SET
      verdict = excluded.verdict,
      severity = excluded.severity,
      payload_json = excluded.payload_json,
      verification_json = excluded.verification_json,
      updated_at = excluded.updated_at
  `);
  const appendHistory = db.prepare(`
    INSERT INTO security_audit_findings_history
      (run_id, fingerprint, verdict, severity, payload_json, verification_json,
       retirement_reason, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const upserted: string[] = [];
  const retired: Array<{ fingerprint: string; reason: string }> = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const record of input.records) {
      assertOneOf(record.verdict, VERDICTS, "verdict");
      if (record.severity !== null) assertOneOf(record.severity, SEVERITIES, "severity");
      const severity = record.verdict === "confirmed" ? record.severity ?? null : null;
      const existing = existingByFingerprint.get(record.fingerprint);
      const verificationHistory = record.verificationHistory ?? existing?.verificationHistory ?? [];
      // Reemplazo material: el estado PREVIO pasa al historial antes del
      // upsert (el historial es append-only y nunca se reescribe).
      if (existing) {
        const payloadChanged =
          JSON.stringify(existing.payload ?? null) !== JSON.stringify(record.payload ?? null);
        if (existing.verdict !== record.verdict || existing.severity !== severity || payloadChanged) {
          appendHistory.run(
            runId,
            record.fingerprint,
            existing.verdict,
            existing.severity,
            json(existing.payload),
            json(existing.verificationHistory),
            "replacement",
            timestamp,
          );
        }
      }
      upsert.run(
        runId,
        record.fingerprint,
        record.verdict,
        severity,
        json(record.payload),
        json(existing?.sourceRefs ?? []),
        json(verificationHistory),
        timestamp,
        timestamp,
      );
      upserted.push(record.fingerprint);
    }
    for (const row of existingRows) {
      if (keep.has(row.fingerprint)) continue;
      const reason =
        (input.retirements?.get(row.fingerprint) ?? input.fallbackRetirementReason ?? "")
          .trim() || "removed_from_findings_map";
      // Historial PRIMERO, borrado DESPUÉS: un retiro jamás pierde la copia.
      appendHistory.run(
        runId,
        row.fingerprint,
        row.verdict,
        row.severity,
        json(row.payload),
        json(row.verificationHistory),
        reason,
        timestamp,
      );
      db.prepare(
        "DELETE FROM security_audit_findings WHERE run_id = ? AND fingerprint = ?",
      ).run(runId, row.fingerprint);
      retired.push({ fingerprint: row.fingerprint, reason });
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { upserted, retired };
}

export interface SecurityAuditFindingHistoryRow {
  historyId: number;
  fingerprint: string;
  verdict: SecurityAuditFindingVerdict;
  severity: SecurityAuditSeverity | null;
  payload: unknown;
  verificationHistory: unknown[];
  retirementReason: string;
  recordedAt: string;
}

/** Historial append-only de hallazgos (incluye reemplazos y retiros). */
export function listSecurityAuditFindingsHistory(
  db: DatabaseSync,
  runId: string,
): SecurityAuditFindingHistoryRow[] {
  const rows = db
    .prepare(
      `SELECT history_id, fingerprint, verdict, severity, payload_json,
              verification_json, retirement_reason, recorded_at
         FROM security_audit_findings_history WHERE run_id = ?
        ORDER BY history_id`,
    )
    .all(runId) as unknown as Array<{
      history_id: number;
      fingerprint: string;
      verdict: SecurityAuditFindingVerdict;
      severity: SecurityAuditSeverity | null;
      payload_json: string;
      verification_json: string;
      retirement_reason: string;
      recorded_at: string;
    }>;
  return rows.map((row) => ({
    historyId: row.history_id,
    fingerprint: row.fingerprint,
    verdict: row.verdict,
    severity: row.severity,
    payload: parseJson<unknown>(row.payload_json, null),
    verificationHistory: parseJson<unknown[]>(row.verification_json, []),
    retirementReason: row.retirement_reason,
    recordedAt: row.recorded_at,
  }));
}

/** Fingerprints con alguna entrada en el historial (retiros y reemplazos). */
export function listSecurityAuditRetiredFingerprints(
  db: DatabaseSync,
  runId: string,
): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT fingerprint FROM security_audit_findings_history
        WHERE run_id = ? ORDER BY fingerprint`,
    )
    .all(runId) as unknown as Array<{ fingerprint: string }>;
  return rows.map((row) => row.fingerprint);
}

export interface SecurityAuditCheckpointRow {
  phase: number;
  state: "pending" | "in_progress" | "complete" | "failed";
  payload: unknown;
  payloadSha256: string;
  createdAt: string;
}

/** Guarda el checkpoint de una fase con hash del payload (transaccional). */
export function recordSecurityAuditCheckpoint(
  db: DatabaseSync,
  runId: string,
  phase: number,
  state: "pending" | "in_progress" | "complete" | "failed",
  payload: unknown,
): SecurityAuditCheckpointRow {
  if (!Number.isInteger(phase) || phase < 1 || phase > 6) {
    throw new Error(`fase inválida: ${phase}`);
  }
  const serialized = JSON.stringify(payload ?? {});
  const payloadSha256 = createHash("sha256").update(serialized).digest("hex");
  const timestamp = now();
  db.prepare(`
    INSERT INTO security_audit_checkpoints
      (run_id, phase, state, payload_json, payload_sha256, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id, phase) DO UPDATE SET
      state = excluded.state,
      payload_json = excluded.payload_json,
      payload_sha256 = excluded.payload_sha256,
      created_at = excluded.created_at
  `).run(runId, phase, state, serialized, payloadSha256, timestamp);
  return { phase, state, payload, payloadSha256, createdAt: timestamp };
}

export function getSecurityAuditCheckpoint(
  db: DatabaseSync,
  runId: string,
  phase: number,
): SecurityAuditCheckpointRow | null {
  const row = db
    .prepare(
      `SELECT phase, state, payload_json, payload_sha256, created_at
         FROM security_audit_checkpoints WHERE run_id = ? AND phase = ?`,
    )
    .get(runId, phase) as
    | {
        phase: number;
        state: SecurityAuditCheckpointRow["state"];
        payload_json: string;
        payload_sha256: string;
        created_at: string;
      }
    | undefined;
  if (!row) return null;
  return {
    phase: row.phase,
    state: row.state,
    payload: parseJson<unknown>(row.payload_json, {}),
    payloadSha256: row.payload_sha256,
    createdAt: row.created_at,
  };
}

export function createSecurityAuditRemediation(
  db: DatabaseSync,
  input: {
    runId: string;
    fingerprint: string;
    executionRunId?: string | null;
  },
): void {
  const timestamp = now();
  db.prepare(`
    INSERT INTO security_audit_remediations
      (run_id, fingerprint, execution_run_id, state, evidence_json, created_at, updated_at)
    VALUES (?, ?, ?, 'requested', '[]', ?, ?)
  `).run(input.runId, input.fingerprint, input.executionRunId ?? null, timestamp, timestamp);
}

/**
 * Transición de estado de una remediación. `verified_fixed` exige evidencia no
 * vacía; sin ella la transición se rechaza (CHECK de tabla + esta guarda).
 */
export function transitionSecurityAuditRemediation(
  db: DatabaseSync,
  runId: string,
  fingerprint: string,
  state: SecurityAuditRemediationState,
  evidence: readonly unknown[] = [],
): void {
  assertOneOf(state, REMEDIATION_STATES, "state");
  if (state === "verified_fixed" && evidence.length === 0) {
    throw new Error("verified_fixed exige evidencia de revalidación");
  }
  const timestamp = now();
  const existing = db
    .prepare(
      "SELECT evidence_json FROM security_audit_remediations WHERE run_id = ? AND fingerprint = ?",
    )
    .get(runId, fingerprint) as { evidence_json: string } | undefined;
  if (!existing) throw new Error(`remediación inexistente: ${fingerprint}`);
  const merged = [
    ...parseJson<unknown[]>(existing.evidence_json, []),
    ...evidence,
  ];
  const info = db
    .prepare(
      `UPDATE security_audit_remediations
         SET state = ?, evidence_json = ?, updated_at = ?,
             completed_at = CASE WHEN ? IN ('verified_fixed', 'rejected') THEN ? ELSE completed_at END
       WHERE run_id = ? AND fingerprint = ?`,
    )
    .run(
      state,
      json(merged),
      timestamp,
      state,
      timestamp,
      runId,
      fingerprint,
    );
  if (Number(info.changes) === 0) throw new Error(`remediación inexistente: ${fingerprint}`);
}

export interface SecurityAuditRemediationRow {
  fingerprint: string;
  executionRunId: string | null;
  state: SecurityAuditRemediationState;
  evidence: unknown[];
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export function listSecurityAuditRemediations(
  db: DatabaseSync,
  runId: string,
): SecurityAuditRemediationRow[] {
  const rows = db
    .prepare(
      `SELECT fingerprint, execution_run_id, state, evidence_json, created_at, updated_at, completed_at
         FROM security_audit_remediations WHERE run_id = ? ORDER BY fingerprint`,
    )
    .all(runId) as unknown as Array<{
      fingerprint: string;
      execution_run_id: string | null;
      state: SecurityAuditRemediationState;
      evidence_json: string;
      created_at: string;
      updated_at: string;
      completed_at: string | null;
    }>;
  return rows.map((row) => ({
    fingerprint: row.fingerprint,
    executionRunId: row.execution_run_id,
    state: row.state,
    evidence: parseJson<unknown[]>(row.evidence_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  }));
}

export interface SecurityAuditReconcileInput {
  /** Unidades del `coverage-ledger.json` oficial (coverage_id o unitId). */
  ledgerUnits: ReadonlyArray<{ unitId?: string; coverage_id?: string; status: string }>;
  /** Registros del `findings.json` oficial. */
  findings: ReadonlyArray<{
    fingerprint: string;
    verdict: SecurityAuditFindingVerdict;
    severity?: SecurityAuditSeverity | null;
  }>;
}

export interface SecurityAuditReconcileReport {
  ok: boolean;
  units: {
    missingInDatabase: string[];
    missingInFile: string[];
    statusMismatches: Array<{ unitId: string; database: string; file: string }>;
  };
  findings: {
    missingInDatabase: string[];
    missingInFile: string[];
    verdictMismatches: Array<{
      fingerprint: string;
      database: SecurityAuditFindingVerdict;
      file: SecurityAuditFindingVerdict;
    }>;
  };
}

/**
 * Reconcilia la base (índice) con los archivos oficiales (fuente canónica) y
 * devuelve las discrepancias sin decidir qué lado corregir.
 */
export function reconcileSecurityAuditRun(
  db: DatabaseSync,
  runId: string,
  input: SecurityAuditReconcileInput,
): SecurityAuditReconcileReport {
  const dbUnits = listSecurityAuditUnits(db, runId);
  const dbFindings = listSecurityAuditFindings(db, runId);
  const dbUnitById = new Map(dbUnits.map((unit) => [unit.unitId, unit]));
  const dbFindingByFingerprint = new Map(
    dbFindings.map((finding) => [finding.fingerprint, finding]),
  );

  const fileUnitIds: string[] = [];
  const statusMismatches: SecurityAuditReconcileReport["units"]["statusMismatches"] = [];
  for (const unit of input.ledgerUnits) {
    const unitId = unit.unitId ?? unit.coverage_id;
    if (!unitId) continue;
    fileUnitIds.push(unitId);
    const stored = dbUnitById.get(unitId);
    if (!stored) continue;
    if (stored.status !== unit.status) {
      statusMismatches.push({ unitId, database: stored.status, file: unit.status });
    }
  }

  const fileFingerprints: string[] = [];
  const verdictMismatches: SecurityAuditReconcileReport["findings"]["verdictMismatches"] = [];
  for (const finding of input.findings) {
    fileFingerprints.push(finding.fingerprint);
    const stored = dbFindingByFingerprint.get(finding.fingerprint);
    if (!stored) continue;
    if (stored.verdict !== finding.verdict) {
      verdictMismatches.push({
        fingerprint: finding.fingerprint,
        database: stored.verdict,
        file: finding.verdict,
      });
    }
  }

  const report: SecurityAuditReconcileReport = {
    units: {
      missingInDatabase: fileUnitIds.filter((id) => !dbUnitById.has(id)),
      missingInFile: dbUnits
        .map((unit) => unit.unitId)
        .filter((id) => !fileUnitIds.includes(id)),
      statusMismatches,
    },
    findings: {
      missingInDatabase: fileFingerprints.filter(
        (fingerprint) => !dbFindingByFingerprint.has(fingerprint),
      ),
      missingInFile: dbFindings
        .map((finding) => finding.fingerprint)
        .filter((fingerprint) => !fileFingerprints.includes(fingerprint)),
      verdictMismatches,
    },
    ok: false,
  };
  report.ok =
    report.units.missingInDatabase.length === 0 &&
    report.units.missingInFile.length === 0 &&
    report.units.statusMismatches.length === 0 &&
    report.findings.missingInDatabase.length === 0 &&
    report.findings.missingInFile.length === 0 &&
    report.findings.verdictMismatches.length === 0;
  return report;
}

export interface SecurityAuditResumePlan {
  completedPhases: number[];
  pendingPhases: number[];
  /** Primera fase pendiente; `null` cuando el run está completo sin huecos. */
  nextPhase: number | null;
  /** Fases completas que NO deben repetirse. */
  phasesNotToRepeat: number[];
}

/**
 * Estado mutable de trabajo del orquestador (F03): los mapas/sets que antes se
 * perdían al interrumpir un run (candidatos, descubridores, instancias de
 * fase 3, pendientes y cursor) se persisten aquí de forma ADITIVA y
 * transaccional. La base sigue siendo un ÍNDICE de reanudación; los archivos
 * oficiales no se tocan desde este módulo.
 */
export type SecurityAuditWorkEngine = "opencode" | "claude";

export interface SecurityAuditWorkStateSnapshot {
  /** Candidato estructurado por fingerprint (salida del hunter). */
  candidateById: Record<string, Record<string, unknown>>;
  /** Descubridor de cada candidato (instancia + motor). */
  discovererByFingerprint: Record<string, { instanceId: string; engine: SecurityAuditWorkEngine }>;
  /** Instancia de fase 3 por fingerprint (fase 5 exige independencia). */
  phase3InstanceByFingerprint: Record<string, string>;
  /** Verificación final fused 3/5 del perfil quick por fingerprint. */
  quickPhase3FinalVerified: Record<string, string>;
  /** Unidad del ledger asociada a cada fingerprint. */
  unitIdByFingerprint: Record<string, string>;
  /** Registros oficiales ya publicados en memoria (fase 3/5) por fingerprint. */
  findings: Record<string, Record<string, unknown>>;
  /** Fingerprints sin validar (gap real conservado). */
  unvalidated: string[];
  /** Unidades diferidas. */
  deferred: string[];
  /** Motivos operativos pendientes registrados (solo los oficiales). */
  pendingReasons: SecurityAuditIncompleteReason[];
  /** Cursor de rotación de roster. */
  cursor: number;
  /** Contador de instancias (los IDs históricos nunca se reutilizan). */
  instanceCounter: number;
  /** Olas de caza iniciadas (evidencia del ledger de presupuesto). */
  wavesStarted: number;
  /** Validadores reales del run en el momento de guardar. */
  ledgerValidator: SecurityAuditValidatorState;
  findingsValidator: SecurityAuditValidatorState;
  /**
   * Paquete 2: clusters de consolidación de candidatos duplicados aplicados
   * (fingerprints alternativos, unitIds y razón). Historial de la fase 3 para
   * reanudación y API; la procedencia de cada alias fingerprint vive en
   * `discovererByFingerprint`.
   */
  consolidations: ConsolidationCluster[];
  /** Paquete 2: unitId alias → unitId canónica consolidada. */
  consolidatedUnitIds: Record<string, string>;
  /**
   * Inicio monotónico del run (ISO); "" cuando el snapshot no lo registra.
   * Juntos con `deadlineAt` forman el presupuesto de duración persistido: la
   * reanudación conserva el deadline original y jamás lo resetea.
   */
  startedAt: string;
  /** Deadline absoluto del run (ISO); "" cuando aún no se fijó o no hay tope. */
  deadlineAt: string;
  savedAt: string;
}

const WORK_ENGINES: readonly SecurityAuditWorkEngine[] = ["opencode", "claude"];

function isPlainJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizedWorkStringMap(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (isPlainJsonRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (typeof key === "string" && key.length > 0 && typeof entry === "string" && entry.length > 0) {
        result[key] = entry;
      }
    }
  }
  return result;
}

/**
 * Convierte el JSON persistido en un snapshot confiable: JSON corrupto o
 * campos malformados se descartan campo a campo y NUNCA producen un `pass`
 * forzado ni instrucciones inventadas (el llamante trata `null`/vacíos como
 * ausencia de estado y recupera los veredictos de los validadores reales).
 */
function sanitizeWorkState(value: unknown): SecurityAuditWorkStateSnapshot {
  const source = isPlainJsonRecord(value) ? value : {};
  const candidateById: Record<string, Record<string, unknown>> = {};
  if (isPlainJsonRecord(source.candidateById)) {
    for (const [fingerprint, candidate] of Object.entries(source.candidateById)) {
      if (fingerprint.length > 0 && isPlainJsonRecord(candidate)) candidateById[fingerprint] = candidate;
    }
  }
  const discovererByFingerprint: SecurityAuditWorkStateSnapshot["discovererByFingerprint"] = {};
  if (isPlainJsonRecord(source.discovererByFingerprint)) {
    for (const [fingerprint, discoverer] of Object.entries(source.discovererByFingerprint)) {
      if (!isPlainJsonRecord(discoverer)) continue;
      const instanceId = discoverer.instanceId;
      const engine = discoverer.engine;
      if (fingerprint.length > 0 && typeof instanceId === "string" && instanceId.length > 0 &&
          typeof engine === "string" && (WORK_ENGINES as readonly string[]).includes(engine)) {
        discovererByFingerprint[fingerprint] = {
          instanceId,
          engine: engine as SecurityAuditWorkEngine,
        };
      }
    }
  }
  const nonNegative = (value: unknown): number =>
    typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
  const isoTimestamp = (value: unknown): string =>
    typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value)) ? value : "";
  const validatorState = (value: unknown): SecurityAuditValidatorState =>
    typeof value === "string" && ["pending", "pass", "fail"].includes(value)
      ? value as SecurityAuditValidatorState
      : "pending";
  const findings: Record<string, Record<string, unknown>> = {};
  if (isPlainJsonRecord(source.findings)) {
    for (const [fingerprint, record] of Object.entries(source.findings)) {
      // Solo registros oficiales (verdict + fingerprint + título/descripción):
      // un payload malformado no se hidrata jamás.
      if (fingerprint.length > 0 && isPlainJsonRecord(record) &&
          typeof record.fingerprint === "string" && record.fingerprint.length > 0 &&
          typeof record.verdict === "string" &&
          (VERDICTS as readonly string[]).includes(record.verdict) &&
          typeof record.title === "string" && typeof record.description === "string") {
        findings[fingerprint] = record;
      }
    }
  }
  return {
    candidateById,
    discovererByFingerprint,
    phase3InstanceByFingerprint: sanitizedWorkStringMap(source.phase3InstanceByFingerprint),
    quickPhase3FinalVerified: sanitizedWorkStringMap(source.quickPhase3FinalVerified),
    unitIdByFingerprint: sanitizedWorkStringMap(source.unitIdByFingerprint),
    findings,
    unvalidated: Array.isArray(source.unvalidated)
      ? source.unvalidated.filter((item): item is string => typeof item === "string" && item.length > 0)
      : [],
    deferred: Array.isArray(source.deferred)
      ? source.deferred.filter((item): item is string => typeof item === "string" && item.length > 0)
      : [],
    pendingReasons: Array.isArray(source.pendingReasons)
      ? source.pendingReasons.filter(
          (item): item is SecurityAuditIncompleteReason =>
            typeof item === "string" && (INCOMPLETE_REASONS as readonly string[]).includes(item),
        )
      : [],
    cursor: nonNegative(source.cursor),
    instanceCounter: nonNegative(source.instanceCounter),
    wavesStarted: nonNegative(source.wavesStarted),
    ledgerValidator: validatorState(source.ledgerValidator),
    findingsValidator: validatorState(source.findingsValidator),
    // Paquete 2: solo clusters íntegros (validados campo a campo); una entrada
    // corrupta se descarta sin romper el resto del snapshot.
    consolidations: Array.isArray(source.consolidations)
      ? source.consolidations
        .map(parseConsolidationCluster)
        .filter((cluster): cluster is ConsolidationCluster => cluster !== null)
      : [],
    consolidatedUnitIds: sanitizedWorkStringMap(source.consolidatedUnitIds),
    startedAt: isoTimestamp(source.startedAt),
    deadlineAt: isoTimestamp(source.deadlineAt),
    savedAt: typeof source.savedAt === "string" ? source.savedAt : "",
  };
}

/**
 * Guarda (upsert transaccional) el estado mutable de trabajo del run. Lanzar
 * sobre JSON inválido es un error de programación: el orquestador registra el
 * fallo y sigue; el run nunca se rompe por el índice de reanudación.
 */
export function saveSecurityAuditWorkState(
  db: DatabaseSync,
  runId: string,
  state: Omit<SecurityAuditWorkStateSnapshot, "savedAt">,
): SecurityAuditWorkStateSnapshot {
  const timestamp = now();
  const serialized = JSON.stringify({ ...state, savedAt: timestamp });
  // Validación del JSON que se va a persistir: un JSON irrecuperable nunca
  // llega a la tabla (la lectura vuelve a validar por si acaso).
  const roundTrip = JSON.parse(serialized) as unknown;
  const snapshot = sanitizeWorkState(roundTrip);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      INSERT INTO security_audit_work_state (run_id, state_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        state_json = excluded.state_json,
        updated_at = excluded.updated_at
    `).run(runId, serialized, timestamp);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return snapshot;
}

/** Lee y valida el estado de trabajo; `null` = sin estado o JSON corrupto. */
export function loadSecurityAuditWorkState(
  db: DatabaseSync,
  runId: string,
): SecurityAuditWorkStateSnapshot | null {
  const row = db
    .prepare("SELECT state_json FROM security_audit_work_state WHERE run_id = ?")
    .get(runId) as { state_json: string } | undefined;
  if (!row) return null;
  try {
    return sanitizeWorkState(JSON.parse(row.state_json) as unknown);
  } catch {
    return null;
  }
}

/**
 * Señal de hueco de fondo (F03): con los 6 checkpoints completos el run puede
 * seguir teniendo trabajo real (gaps de crítico/presupuesto, candidatos de
 * fase 3 sin validar, validadores en fail, cierre incomplete). Devuelve la
 * fase que resuelve el hueco (2..6) o `null` si no hay ninguno.
 */
function resumeGapPhase(
  db: DatabaseSync,
  run: SecurityAuditRunRow,
  workState: SecurityAuditWorkStateSnapshot | null,
): number | null {
  const pendingReasons = new Set<SecurityAuditIncompleteReason>(
    workState?.pendingReasons ?? (run.incompleteReason ? [run.incompleteReason] : []),
  );
  // Gap de crítico/presupuesto/proveedor → se vuelve a la fase 2 (caza/crítico).
  const nonValidatorReasons = [...pendingReasons].filter((reason) => reason !== "validator_failed");
  if (nonValidatorReasons.length > 0) return 2;
  // Candidatos de fase 3 pendientes (unidades candidate) → fase 3.
  const hasCandidateUnits = listSecurityAuditUnits(db, run.runId).some(
    (unit) => unit.status === "candidate",
  );
  if (hasCandidateUnits) return 3;
  // Salida estructurada con validadores no PASS (o validador oficial que
  // rechazó) → fase 4.
  if (
    run.ledgerValidator !== "pass" ||
    run.findingsValidator !== "pass" ||
    pendingReasons.has("validator_failed")
  ) {
    return 4;
  }
  // Fingerprints sin validar sin unidades candidatas (reemplazos de fase 5
  // retirados) → fase 5 (verificación final del registro).
  if ((workState?.unvalidated.length ?? 0) > 0) return 5;
  // Run incomplete sin ningún otro hueco registrado → publicar informes (6).
  if (run.runStatus !== "complete") return 6;
  return null;
}

/**
 * Plan de reanudación: nunca repite una fase con checkpoint `complete` y
 * columna de fase `complete`; devuelve la primera pendiente.
 *
 * Con los 6 checkpoints completos pero huecos reales (candidatos sin validar,
 * pendingReasons, validadores en fail o run incomplete) se reanuda en la fase
 * que resuelve el hueco y se descartan del PLAN los checkpoints posteriores;
 * las filas de checkpoints se conservan (el historial nunca se borra).
 * `nextPhase = null` solo cuando el run está complete y sin huecos.
 */
export function planSecurityAuditResume(
  db: DatabaseSync,
  runId: string,
): SecurityAuditResumePlan {
  const run = getSecurityAuditRun(db, runId);
  if (!run) throw new Error(`run no encontrado: ${runId}`);
  const workState = loadSecurityAuditWorkState(db, runId);
  const completedPhases: number[] = [];
  const pendingPhases: number[] = [];
  for (let phase = 1; phase <= 6; phase += 1) {
    const checkpoint = getSecurityAuditCheckpoint(db, runId, phase);
    const phaseState = run.phases[phase - 1];
    const done = phaseState === "complete" && checkpoint?.state === "complete";
    if (done) completedPhases.push(phase);
    else pendingPhases.push(phase);
  }
  if (pendingPhases.length === 0) {
    const gapPhase = resumeGapPhase(db, run, workState);
    if (gapPhase === null) {
      return {
        completedPhases,
        pendingPhases: [],
        nextPhase: null,
        phasesNotToRepeat: completedPhases,
      };
    }
    // Los checkpoints posteriores al hueco quedan descartados del plan (se
    // repetirán); sus filas siguen en security_audit_checkpoints.
    const plannedCompleted = completedPhases.filter((phase) => phase < gapPhase);
    const plannedPending = [gapPhase, gapPhase + 1, gapPhase + 2, gapPhase + 3, gapPhase + 4, gapPhase + 5]
      .filter((phase) => phase <= 6);
    return {
      completedPhases: plannedCompleted,
      pendingPhases: plannedPending,
      nextPhase: gapPhase,
      phasesNotToRepeat: plannedCompleted,
    };
  }
  const nextPhase =
    run.runStatus === "complete" ? null : (pendingPhases[0] ?? null);
  return {
    completedPhases,
    pendingPhases,
    nextPhase,
    phasesNotToRepeat: completedPhases,
  };
}

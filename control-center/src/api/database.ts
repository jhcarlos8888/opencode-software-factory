import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { buildExecutionSummary, createHandoffId, formatRoundSummaryMessage, type ExecutionSummary, type HandoffDescriptor, type HandoffOutputMetadata, type HandoffOutputRecord, type AgentResult } from "./orchestration.js";
import { MAX_FILES_PER_WORK_THREAD, type InstructionFileMetadata, type StoredInstructionFile, type ValidInstructionFile } from "./instruction-files.js";
import { workInstructionLimitError } from "./work-instruction-limit.js";
import { initializeSecurityAuditSchema } from "./security-audit-persistence.js";

export type EngineId = "opencode" | "claude";
export type ClaudeProviderId = "apmix" | "anthropic" | "opencode-go";
export type ModelTier = "economy" | "balanced" | "premium";
export interface FavoriteModel { engine: EngineId; provider: string; modelId: string; tier: ModelTier; }
export type PermissionProfile = "read-only" | "workspace-write" | "approval-required";
export type PermissionMode = "automatic" | "manual";

export interface AgentAssignment {
  agentId: string;
  engine: EngineId;
  modelId: string;
  permissionMode: PermissionMode;
  permissionProfile: PermissionProfile;
  enabled: boolean;
}

const stateDir = process.env.FACTORY_STATE_DIR
  ? join(process.env.FACTORY_STATE_DIR, "control-center")
  : join(homedir(), ".local", "state", "opencode-software-factory", "control-center");

// Secure the factory-owned default state directory. FACTORY_STATE_DIR is an
// externally managed base path and may be shared (for example /tmp); never
// change its permissions, only the private control-center child directory.
if (!process.env.FACTORY_STATE_DIR) {
  const stateRoot = dirname(stateDir);
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const stateRootInfo = lstatSync(stateRoot);
  if (!stateRootInfo.isDirectory() || stateRootInfo.isSymbolicLink()) {
    throw new Error("El directorio raíz del estado de Control Center debe ser real y privado, no un enlace simbólico.");
  }
  chmodSync(stateRoot, 0o700);
}

mkdirSync(stateDir, { recursive: true, mode: 0o700 });
const stateDirInfo = lstatSync(stateDir);
if (!stateDirInfo.isDirectory() || stateDirInfo.isSymbolicLink()) {
  throw new Error("El directorio de estado de Control Center debe ser un directorio real, no un enlace simbólico.");
}
chmodSync(stateDir, 0o700);

const databasePath = join(stateDir, "control-center.sqlite");
try {
  const databaseInfo = lstatSync(databasePath);
  if (!databaseInfo.isFile() || databaseInfo.isSymbolicLink()) {
    throw new Error("El archivo SQLite de Control Center debe ser un archivo regular, no un enlace simbólico.");
  }
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const db = new DatabaseSync(databasePath);
chmodSync(databasePath, 0o600);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS claude_provider_preferences (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    provider TEXT NOT NULL CHECK (provider IN ('apmix', 'anthropic', 'opencode-go')),
    updated_at TEXT NOT NULL
  );
  INSERT INTO claude_provider_preferences (id, provider, updated_at)
    VALUES (1, 'apmix', CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO NOTHING;
  CREATE TABLE IF NOT EXISTS favorite_models (
    engine TEXT NOT NULL CHECK (engine IN ('opencode', 'claude')),
    provider TEXT NOT NULL,
    model_id TEXT NOT NULL,
    tier TEXT NOT NULL CHECK (tier IN ('economy', 'balanced', 'premium')),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (engine, provider, model_id)
  );
  CREATE TABLE IF NOT EXISTS project_preferences (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    project_path TEXT NOT NULL DEFAULT '',
    instructions TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS project_preflight (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    project_path TEXT NOT NULL,
    instructions_sha256 TEXT NOT NULL,
    analysis_json TEXT NOT NULL,
    decision TEXT CHECK (decision IN ('accepted', 'manual') OR decision IS NULL),
    team_fingerprint TEXT,
    consumed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  INSERT INTO project_preferences (id, project_path, instructions, updated_at)
    VALUES (1, '', '', CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO NOTHING;
  CREATE TABLE IF NOT EXISTS agent_assignments (
    agent_id TEXT PRIMARY KEY,
    engine TEXT NOT NULL CHECK (engine IN ('opencode', 'claude')),
    model_id TEXT NOT NULL,
    permission_profile TEXT NOT NULL CHECK (
      permission_profile IN ('read-only', 'workspace-write', 'approval-required')
    ),
    permission_mode TEXT NOT NULL DEFAULT 'automatic' CHECK (permission_mode IN ('automatic', 'manual')),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS work_threads (
    id TEXT PRIMARY KEY,
    project_path TEXT NOT NULL,
    objective TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS execution_runs (
    id TEXT PRIMARY KEY,
    project_path TEXT NOT NULL,
    instructions TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    finished_at TEXT,
    summary_json TEXT
  );
  CREATE TABLE IF NOT EXISTS execution_agents (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES execution_runs(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    engine TEXT NOT NULL,
    model_id TEXT NOT NULL,
    permission_profile TEXT NOT NULL,
    status TEXT NOT NULL,
    session_id TEXT,
    process_id INTEGER,
    error TEXT,
    started_at TEXT,
    finished_at TEXT,
    handoff_in_json TEXT NOT NULL DEFAULT '[]',
    handoff_out_json TEXT,
    handoff_output_json TEXT
  );
  CREATE TABLE IF NOT EXISTS execution_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES execution_runs(id) ON DELETE CASCADE,
    agent_run_id TEXT,
    created_at TEXT NOT NULL,
    area TEXT NOT NULL,
    kind TEXT NOT NULL,
    message TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS execution_decisions (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES execution_runs(id) ON DELETE CASCADE,
    agent_run_id TEXT NOT NULL,
    engine TEXT NOT NULL,
    engine_session_id TEXT,
    engine_request_id TEXT,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    details_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending',
    response TEXT,
    created_at TEXT NOT NULL,
    resolved_at TEXT
  );
  CREATE TABLE IF NOT EXISTS work_messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES work_threads(id) ON DELETE CASCADE,
    run_id TEXT REFERENCES execution_runs(id) ON DELETE SET NULL,
    round_number INTEGER NOT NULL DEFAULT 1,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    kind TEXT NOT NULL DEFAULT 'message',
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS work_instruction_files (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES work_threads(id) ON DELETE CASCADE,
    round_number INTEGER NOT NULL CHECK(round_number > 0),
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    byte_length INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_work_instruction_files_thread ON work_instruction_files(thread_id, round_number);
  CREATE INDEX IF NOT EXISTS idx_work_messages_thread ON work_messages(thread_id, id);
  CREATE INDEX IF NOT EXISTS idx_execution_events_run ON execution_events(run_id, id);
  CREATE INDEX IF NOT EXISTS idx_execution_decisions_pending ON execution_decisions(run_id, status);
`);
for (const sidecar of [databasePath + "-wal", databasePath + "-shm"]) {
  try { chmodSync(sidecar, 0o600); } catch { /* SQLite may not have created this sidecar yet. */ }
}

// Additive migrations for structured orchestration metadata.
function ensureColumn(table: string, column: string, definition: string): void {
  const columns = db.prepare("PRAGMA table_info(" + table + ")").all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) {
    db.exec("ALTER TABLE " + table + " ADD COLUMN " + column + " " + definition);
  }
}
ensureColumn("execution_runs", "summary_json", "TEXT");
ensureColumn("execution_runs", "thread_id", "TEXT REFERENCES work_threads(id) ON DELETE SET NULL");
ensureColumn("execution_runs", "round_number", "INTEGER NOT NULL DEFAULT 1");
ensureColumn("execution_runs", "configuration_snapshot_json", "TEXT");
ensureColumn("execution_runs", "continuity_context", "TEXT");
db.exec("CREATE INDEX IF NOT EXISTS idx_execution_runs_thread ON execution_runs(thread_id, round_number)");

// Attach pre-existing standalone executions to a durable thread without changing
// their IDs, instructions, events, summaries, agents or terminal states.
const legacyRuns = db.prepare("SELECT id, project_path AS projectPath, instructions, status, started_at AS startedAt, updated_at AS updatedAt, summary_json AS summaryJson FROM execution_runs WHERE thread_id IS NULL AND CASE WHEN json_valid(configuration_snapshot_json) THEN json_type(configuration_snapshot_json, '$.focusedRevalidation') IS NULL AND json_type(configuration_snapshot_json, '$.securityAudit') IS NULL ELSE 1 END ORDER BY started_at").all() as Array<{
  id: string; projectPath: string; instructions: string; status: string;
  startedAt: string; updatedAt: string; summaryJson: string | null;
}>;
if (legacyRuns.length) {
  const insertThread = db.prepare("INSERT OR IGNORE INTO work_threads (id, project_path, objective, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)");
  const linkRun = db.prepare("UPDATE execution_runs SET thread_id = ?, round_number = 1 WHERE id = ? AND thread_id IS NULL");
  const insertMessage = db.prepare("INSERT INTO work_messages (id, thread_id, run_id, round_number, role, kind, content, created_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?)");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const legacy of legacyRuns) {
      const threadId = "legacy-" + legacy.id;
      const terminal = legacy.status === "succeeded" ? "completed"
        : ["queued", "running", "waiting"].includes(legacy.status) ? "active" : "failed";
      insertThread.run(threadId, legacy.projectPath, legacy.instructions, terminal, legacy.startedAt, legacy.updatedAt);
      linkRun.run(threadId, legacy.id);
      insertMessage.run(randomUUID(), threadId, null, "user", "initial-instruction", legacy.instructions, legacy.startedAt);
      if (legacy.summaryJson) {
        const summary = JSON.parse(legacy.summaryJson) as { headline?: string; overview?: string; findings?: string[]; nextSteps?: string[] };
        const content = [
          summary.headline ?? "Resumen de la ejecución histórica",
          summary.overview ?? "",
          summary.findings?.length ? "Hallazgos: " + summary.findings.join(" | ") : "",
          summary.nextSteps?.length ? "Próximos pasos: " + summary.nextSteps.join(" | ") : ""
        ].filter(Boolean).join("\n\n");
        insertMessage.run(randomUUID(), threadId, legacy.id, "assistant", "round-summary", content, legacy.updatedAt);
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
ensureColumn("agent_assignments", "permission_mode", "TEXT NOT NULL DEFAULT 'automatic' CHECK (permission_mode IN ('automatic', 'manual'))");
ensureColumn("execution_agents", "handoff_in_json", "TEXT NOT NULL DEFAULT '[]'");
ensureColumn("execution_agents", "handoff_out_json", "TEXT");
ensureColumn("execution_agents", "handoff_output_json", "TEXT");
ensureColumn("execution_agents", "handoff_output_meta_json", "TEXT");

// Migrate the provider preference constraint for installations created before OpenCode Go support.
const providerTable = db.prepare(
  "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'claude_provider_preferences'"
).get() as { sql: string } | undefined;
if (providerTable && !providerTable.sql.includes("'opencode-go'")) {
  db.exec(`
    BEGIN IMMEDIATE;
    ALTER TABLE claude_provider_preferences RENAME TO claude_provider_preferences_legacy;
    CREATE TABLE claude_provider_preferences (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      provider TEXT NOT NULL CHECK (provider IN ('apmix', 'anthropic', 'opencode-go')),
      updated_at TEXT NOT NULL
    );
    INSERT INTO claude_provider_preferences (id, provider, updated_at)
      SELECT id, provider, updated_at FROM claude_provider_preferences_legacy;
    DROP TABLE claude_provider_preferences_legacy;
    COMMIT;
  `);
}

// Índice de recuperación de los runs security-audit. Los archivos oficiales
// (coverage-ledger.json, findings.json, run-metadata.json) siguen siendo la
// fuente canónica; estas tablas solo indexan y habilitan reanudación.
// Llamada única, idempotente y aditiva, después del esquema actual.
initializeSecurityAuditSchema(db);

export function listAssignments(): AgentAssignment[] {
  const rows = db.prepare(
    "SELECT agent_id, engine, model_id, permission_mode, permission_profile, enabled FROM agent_assignments ORDER BY agent_id"
  ).all() as Array<{
    agent_id: string;
    engine: EngineId;
    model_id: string;
    permission_mode: PermissionMode;
    permission_profile: PermissionProfile;
    enabled: number;
  }>;

  return rows.map((row) => ({
    agentId: row.agent_id,
    engine: row.engine,
    modelId: row.model_id,
    permissionMode: row.permission_mode,
    permissionProfile: row.permission_profile,
    enabled: row.enabled === 1
  }));
}

export function saveAssignments(assignments: AgentAssignment[]): void {
  const statement = db.prepare(`
    INSERT INTO agent_assignments
      (agent_id, engine, model_id, permission_mode, permission_profile, enabled, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_id) DO UPDATE SET
      engine = excluded.engine,
      model_id = excluded.model_id,
      permission_mode = excluded.permission_mode,
      permission_profile = excluded.permission_profile,
      enabled = excluded.enabled,
      updated_at = excluded.updated_at
  `);

  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const item of assignments) {
      statement.run(
        item.agentId,
        item.engine,
        item.modelId,
        item.permissionMode,
        item.permissionProfile,
        item.enabled ? 1 : 0,
        now
      );
    }
    // Keep the exact team fingerprint in the same transaction as its assignments.
    recordProjectPreflightTeamSave();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export const databaseInfo = {
  path: databasePath,
  engine: "SQLite"
} as const;

export function getClaudeProviderPreference(): ClaudeProviderId {
  const row = db.prepare(
    "SELECT provider FROM claude_provider_preferences WHERE id = 1"
  ).get() as { provider: ClaudeProviderId } | undefined;
  return row?.provider ?? "apmix";
}

export function saveClaudeProviderPreference(provider: ClaudeProviderId): void {
  db.prepare(`
    INSERT INTO claude_provider_preferences (id, provider, updated_at)
    VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      provider = excluded.provider,
      updated_at = excluded.updated_at
  `).run(provider, new Date().toISOString());
}

export function listFavoriteModels(): FavoriteModel[] {
  return db.prepare(
    "SELECT engine, provider, model_id AS modelId, tier FROM favorite_models ORDER BY engine, provider, tier, model_id"
  ).all() as unknown as FavoriteModel[];
}

export function saveFavoriteModels(models: FavoriteModel[]): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DELETE FROM favorite_models");
    const stmt = db.prepare(
      "INSERT INTO favorite_models (engine, provider, model_id, tier, updated_at) VALUES (?, ?, ?, ?, ?)"
    );
    const now = new Date().toISOString();
    for (const item of models) stmt.run(item.engine, item.provider, item.modelId, item.tier, now);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Align stale persisted Claude/APMix selections with the model currently
 * configured in ~/.claude/settings.json. Credentials are never read here.
 */
export function synchronizeConfiguredClaudeModel(
  provider: ClaudeProviderId,
  preferredModelId: string,
  validModelIds: string[]
): { assignmentsUpdated: number; favoritesUpdated: number } {
  const valid = new Set(validModelIds);
  if (!preferredModelId || !valid.has(preferredModelId)) {
    return { assignmentsUpdated: 0, favoritesUpdated: 0 };
  }

  let assignmentsUpdated = 0;
  let favoritesUpdated = 0;
  const now = new Date().toISOString();

  db.exec("BEGIN IMMEDIATE");
  try {
    const assignments = db.prepare(
      "SELECT agent_id AS agentId, model_id AS modelId FROM agent_assignments WHERE engine = 'claude'"
    ).all() as Array<{ agentId: string; modelId: string }>;
    const updateAssignment = db.prepare(
      "UPDATE agent_assignments SET model_id = ?, updated_at = ? WHERE agent_id = ?"
    );
    for (const assignment of assignments) {
      if (!valid.has(assignment.modelId)) {
        updateAssignment.run(preferredModelId, now, assignment.agentId);
        assignmentsUpdated++;
      }
    }

    const favorites = db.prepare(
      "SELECT provider, model_id AS modelId FROM favorite_models WHERE engine = 'claude'"
    ).all() as Array<{ provider: string; modelId: string }>;
    const hasPreferredFavorite = db.prepare(
      "SELECT 1 AS present FROM favorite_models WHERE engine = 'claude' AND provider = ? AND model_id = ?"
    );
    const updateFavorite = db.prepare(
      "UPDATE favorite_models SET provider = ?, model_id = ?, updated_at = ? WHERE engine = 'claude' AND provider = ? AND model_id = ?"
    );
    const deleteFavorite = db.prepare(
      "DELETE FROM favorite_models WHERE engine = 'claude' AND provider = ? AND model_id = ?"
    );
    for (const favorite of favorites) {
      if (favorite.provider === provider && valid.has(favorite.modelId)) continue;
      if (hasPreferredFavorite.get(provider, preferredModelId)) {
        deleteFavorite.run(favorite.provider, favorite.modelId);
      } else {
        const nextModel = valid.has(favorite.modelId) ? favorite.modelId : preferredModelId;
        updateFavorite.run(provider, nextModel, now, favorite.provider, favorite.modelId);
      }
      favoritesUpdated++;
    }

    db.exec("COMMIT");
    return { assignmentsUpdated, favoritesUpdated };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function getProjectPreferences(): { path: string; instructions: string } {
  const row = db.prepare("SELECT project_path AS path, instructions FROM project_preferences WHERE id = 1")
    .get() as { path: string; instructions: string } | undefined;
  return row ?? { path: "", instructions: "" };
}

export function saveProjectPreferences(path: string, instructions: string): void {
  db.prepare(`
    INSERT INTO project_preferences (id, project_path, instructions, updated_at)
    VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      project_path = excluded.project_path,
      instructions = excluded.instructions,
      updated_at = excluded.updated_at
  `).run(path, instructions, new Date().toISOString());
}

export type ProjectPreflightDecision = "accepted" | "manual";

export interface ProjectPreflightSnapshot {
  path: string;
  analysis: Record<string, unknown>;
  decision: ProjectPreflightDecision | null;
  teamSaved: boolean;
  consumed: boolean;
  preconsultedAt: string;
}

function hashPreflightDepth(depth: string): string {
  return createHash("sha256").update(depth.trim(), "utf8").digest("hex");
}

function currentAssignmentsFingerprint(): string {
  const assignments = db.prepare(
    "SELECT agent_id AS agentId, engine, model_id AS modelId, permission_mode AS permissionMode, permission_profile AS permissionProfile, enabled FROM agent_assignments ORDER BY agent_id"
  ).all() as Array<{
    agentId: string; engine: string; modelId: string; permissionMode: string; permissionProfile: string; enabled: number;
  }>;
  return createHash("sha256").update(JSON.stringify(assignments), "utf8").digest("hex");
}

/** Persist read-only discovery and invalidate any older decision/team approval. */
export function recordProjectPreflight(path: string, depth: string, analysis: Record<string, unknown>): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO project_preflight
      (id, project_path, instructions_sha256, analysis_json, decision, team_fingerprint, consumed_at, created_at, updated_at)
    VALUES (1, ?, ?, ?, NULL, NULL, NULL, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      project_path = excluded.project_path,
      instructions_sha256 = excluded.instructions_sha256,
      analysis_json = excluded.analysis_json,
      decision = NULL,
      team_fingerprint = NULL,
      consumed_at = NULL,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at
  `).run(path.trim(), hashPreflightDepth(depth), JSON.stringify(analysis), now, now);
}

/** Return the latest project-only preflight; an optional depth must match exactly. */
export function getProjectPreflight(path: string, depth?: string): ProjectPreflightSnapshot | null {
  const row = db.prepare(`
    SELECT project_path AS path, instructions_sha256 AS instructionsHash,
           analysis_json AS analysisJson, decision, team_fingerprint AS teamFingerprint,
           consumed_at AS consumedAt, created_at AS createdAt
    FROM project_preflight WHERE id = 1
  `).get() as {
    path: string; instructionsHash: string; analysisJson: string; decision: ProjectPreflightDecision | null;
    teamFingerprint: string | null; consumedAt: string | null; createdAt: string;
  } | undefined;
  if (!row || row.path !== path.trim() || (depth !== undefined && row.instructionsHash !== hashPreflightDepth(depth))) return null;
  const analysis = JSON.parse(row.analysisJson) as Record<string, unknown>;
  // Legacy preflights were bound to task instructions; require the new project-only contract.
  if (!analysis.projectPlan || typeof analysis.projectPlan !== "object") return null;
  return {
    path: row.path,
    analysis,
    decision: row.decision,
    teamSaved: Boolean(row.teamFingerprint && row.teamFingerprint === currentAssignmentsFingerprint()),
    consumed: Boolean(row.consumedAt),
    preconsultedAt: row.createdAt
  };
}

/** Record the user's explicit accept/manual choice for the matching preconsultation. */
export function decideProjectPreflight(
  path: string,
  depth: string,
  decision: ProjectPreflightDecision
): boolean {
  const result = db.prepare(`
    UPDATE project_preflight
    SET decision = ?, team_fingerprint = NULL, consumed_at = NULL, updated_at = ?
    WHERE id = 1 AND project_path = ? AND instructions_sha256 = ?
  `).run(decision, new Date().toISOString(), path.trim(), hashPreflightDepth(depth));
  return Number(result.changes) === 1;
}

/** Bind a saved team to the current preflight only after an explicit decision. */
export function recordProjectPreflightTeamSave(): void {
  const row = db.prepare("SELECT decision FROM project_preflight WHERE id = 1").get() as { decision: string | null } | undefined;
  if (!row?.decision) return;
  db.prepare("UPDATE project_preflight SET team_fingerprint = ?, updated_at = ? WHERE id = 1")
    .run(currentAssignmentsFingerprint(), new Date().toISOString());
}

/** Atomically consume the preflight so one approval cannot start multiple initial runs. */
export function consumeProjectPreflight(path: string, depth: string): { consumed: boolean; reason?: string } {
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare(`
      SELECT project_path AS path, instructions_sha256 AS instructionsHash, decision,
             team_fingerprint AS teamFingerprint, consumed_at AS consumedAt
      FROM project_preflight WHERE id = 1
    `).get() as {
      path: string; instructionsHash: string; decision: ProjectPreflightDecision | null;
      teamFingerprint: string | null; consumedAt: string | null;
    } | undefined;
    if (!row || row.path !== path.trim() || row.instructionsHash !== hashPreflightDepth(depth)) {
      db.exec("ROLLBACK");
      return { consumed: false, reason: "La ruta o profundidad de preconsulta cambiaron. Vuelve a consultar el proyecto." };
    }
    if (!row.decision) {
      db.exec("ROLLBACK");
      return { consumed: false, reason: "Completa la preconsulta y registra la aceptación de la propuesta o la configuración manual." };
    }
    if (row.consumedAt) {
      db.exec("ROLLBACK");
      return { consumed: false, reason: "Esta preconsulta ya fue utilizada. Ejecuta una nueva preconsulta para iniciar otra ejecución inicial." };
    }
    const fingerprint = currentAssignmentsFingerprint();
    if (!row.teamFingerprint || row.teamFingerprint !== fingerprint) {
      db.exec("ROLLBACK");
      return { consumed: false, reason: "Guarda el equipo después de aceptar la propuesta o elegir la configuración manual." };
    }
    const now = new Date().toISOString();
    db.prepare("UPDATE project_preflight SET consumed_at = ?, updated_at = ? WHERE id = 1").run(now, now);
    db.exec("COMMIT");
    return { consumed: true };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}


export type ExecutionStatus = "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "interrupted";
export type ExecutionAgentStatus = ExecutionStatus | "skipped";
export type ExecutionDecisionStatus = "pending" | "responding" | "approved" | "rejected" | "answered" | "orphaned";

export interface ExecutionConfigurationSnapshot {
  capturedAt: string;
  auditorScope?: string;
  auditorCapabilities?: { roots: string[]; metadata: string[]; configs: string[]; testRoots: string[]; markers: string[] };
  claudeProvider: ClaudeProviderId;
  favorites: FavoriteModel[];
  assignments: AgentAssignment[];
  taskPlan?: {
    kind: string;
    complexity: string;
    depth: string;
    recommendedAgents: string[];
    reasons: string[];
    changesExpected: boolean;
  };
  permissionResolution?: Array<{
    agentId: string;
    configuredMode: PermissionMode;
    effectiveProfile: PermissionProfile;
    reason: string;
  }>;
  agentSelection?: {
    selectedAgentIds: string[];
    skippedAgentIds: string[];
    mandatoryAgentIds: string[];
  };
  roleInstructionDigests: Record<string, string>;
  roleInstructions: Record<string, string>;
  instructionFiles?: Array<{ id: string; name: string; sha256: string; byteLength: number }>;
  workflowSkillDigest: string | null;
  workflowSkillContent: string;
  /** Modalidad security-audit (solo cuando la rama existe). */
  securityAudit?: {
    profile: string;
    scope: unknown;
    budget: { maxInvocations: number | null; maxConcurrency: number; maxDurationMs: number };
    executionPolicy: string;
    resumeRunId: string | null;
    roster: Array<{ agentId: string; engine: string; modelId: string }>;
  };
  /** Remediación explícita vinculada al run de auditoría de origen. */
  securityRemediation?: { auditRunId: string; fingerprints: string[] };
  focusedRevalidation?: { planSha256:string; auditRunId:string; fingerprint:string };
}
export interface WorkThreadRecord {
  id: string;
  projectPath: string;
  objective: string;
  status: "active" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
}
export interface WorkMessageRecord {
  id: string;
  threadId: string;
  runId: string | null;
  roundNumber: number;
  role: "user" | "assistant" | "system";
  kind: string;
  content: string;
  createdAt: string;
}
export interface ExecutionRunRecord {
  id: string;
  threadId: string | null;
  roundNumber: number;
  configurationSnapshot: ExecutionConfigurationSnapshot | null;
  continuityContext: string;
  projectPath: string;
  instructions: string;
  status: ExecutionStatus;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  summary: ExecutionSummary | null;
}
export interface ExecutionAgentRecord {
  id: string;
  runId: string;
  agentId: string;
  engine: EngineId;
  modelId: string;
  permissionProfile: PermissionProfile;
  status: ExecutionAgentStatus;
  sessionId: string | null;
  processId: number | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  handoffIn: HandoffDescriptor[];
  handoffOut: HandoffDescriptor[];
  handoffOutput: HandoffOutputMetadata | null;
}
export interface ExecutionEventRecord {
  id: number;
  runId: string;
  agentRunId: string | null;
  createdAt: string;
  area: string;
  kind: string;
  message: string;
}
export interface ExecutionDecisionRecord {
  id: string;
  runId: string;
  agentRunId: string;
  engine: EngineId;
  engineSessionId: string | null;
  engineRequestId: string | null;
  kind: "permission" | "question";
  title: string;
  description: string;
  details: unknown;
  status: ExecutionDecisionStatus;
  response: string | null;
  createdAt: string;
  resolvedAt: string | null;
}
export interface ExecutionSnapshot {
  run: ExecutionRunRecord;
  agents: ExecutionAgentRecord[];
  events: ExecutionEventRecord[];
  decisions: ExecutionDecisionRecord[];
  decisionHistory: ExecutionDecisionRecord[];
}

export function createExecutionRecords(
  run: Omit<ExecutionRunRecord, "updatedAt" | "finishedAt" | "summary">,
  agents: Array<Omit<ExecutionAgentRecord, "runId" | "sessionId" | "processId" | "error" | "startedAt" | "finishedAt" | "handoffIn" | "handoffOut" | "handoffOutput"> & { error?: string | null; finishedAt?: string | null }>
): void {
  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      INSERT INTO execution_runs
        (id, project_path, instructions, status, started_at, updated_at, finished_at,
         thread_id, round_number, configuration_snapshot_json, continuity_context)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
    `).run(
      run.id, run.projectPath, run.instructions, run.status, run.startedAt, now,
      run.threadId, run.roundNumber, run.configurationSnapshot ? JSON.stringify(run.configurationSnapshot) : null,
      run.continuityContext ?? ""
    );
    const insertAgent = db.prepare(`
      INSERT INTO execution_agents
        (id, run_id, agent_id, engine, model_id, permission_profile, status, error, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const agent of agents) {
      insertAgent.run(
        agent.id, run.id, agent.agentId, agent.engine, agent.modelId, agent.permissionProfile,
        agent.status, agent.error ?? null, agent.status === "skipped" ? null : agent.finishedAt ?? null
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function appendExecutionAgent(agent: {
  id: string;
  runId: string;
  agentId: string;
  engine: EngineId;
  modelId: string;
  permissionProfile: PermissionProfile;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "skipped";
  error?: string | null;
}): void {
  // Instancias adicionales fuera de los 7 agentes fijos (modalidad
  // security-audit): cada invocación registra su propia fila con identidad,
  // motor, modelo y permiso efectivo reales.
  db.prepare(`
    INSERT INTO execution_agents
      (id, run_id, agent_id, engine, model_id, permission_profile, status, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    agent.id,
    agent.runId,
    agent.agentId,
    agent.engine,
    agent.modelId,
    agent.permissionProfile,
    agent.status,
    agent.error ?? null
  );
}

/** Instancia de la base de datos del proceso (modalidad security-audit). */
export function getFactoryDatabase(): DatabaseSync {
  return db;
}

/**
 * Ejecuciones de la modalidad security-audit asociadas a un run: la original
 * (`id = auditRunId`) y su reanudación (`securityAudit.resumeRunId`).
 * **No** incluye ejecuciones de remediación: esos vínculos se consultan en
 * `security_audit_remediations.execution_run_id` (consulta separada). Se
 * resuelve con `json_extract` (sin LIKE) y se devuelve la más reciente al
 * final.
 */
export function listSecurityAuditExecutionRunIds(auditRunId: string): string[] {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(auditRunId)) return [];
  const rows = db
    .prepare(
      "SELECT id FROM execution_runs WHERE id = ? OR (" +
        "json_valid(configuration_snapshot_json) AND " +
        "json_extract(configuration_snapshot_json, '$.securityAudit.resumeRunId') = ?" +
        ") ORDER BY started_at ASC, id ASC",
    )
    .all(auditRunId, auditRunId) as unknown as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

/** Estado terminal de una ejecución por id, o `null` si no existe. */
export function getExecutionRunStatus(id: string): ExecutionStatus | null {
  if (!id) return null;
  const row = db
    .prepare("SELECT status FROM execution_runs WHERE id = ?")
    .get(id) as { status: ExecutionStatus } | undefined;
  return row?.status ?? null;
}

export function updateExecutionSummary(id: string, summary: ExecutionSummary): void {
  db.prepare("UPDATE execution_runs SET summary_json = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(summary), new Date().toISOString(), id);
}

export function updateExecutionRun(id: string, status: ExecutionStatus, finished = false): void {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE execution_runs SET status = ?, updated_at = ?, finished_at = ?
    WHERE id = ?
  `).run(status, now, finished ? now : null, id);
}
export function updateExecutionAgent(
  id: string,
  patch: Partial<Pick<ExecutionAgentRecord, "status" | "sessionId" | "processId" | "error" | "startedAt" | "finishedAt" | "handoffIn" | "handoffOut">> & {
    handoffOutput?: HandoffOutputRecord | null;
  }
): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  const mapping: Record<string, string> = {
    status: "status", sessionId: "session_id", processId: "process_id", error: "error",
    startedAt: "started_at", finishedAt: "finished_at",
    handoffIn: "handoff_in_json", handoffOut: "handoff_out_json"
  };
  for (const [key, column] of Object.entries(mapping)) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      fields.push(`${column} = ?`);
      const value = (patch as Record<string, unknown>)[key];
      values.push(key === "handoffIn" || key === "handoffOut"
        ? JSON.stringify(value ?? (key === "handoffIn" ? [] : null))
        : value);
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, "handoffOutput")) {
    const output = patch.handoffOutput ?? null;
    fields.push("handoff_output_json = ?");
    values.push(output ? JSON.stringify(output) : null);
    fields.push("handoff_output_meta_json = ?");
    if (output) {
      const { content: _content, ...metadata } = output;
      values.push(JSON.stringify(metadata));
    } else {
      values.push(null);
    }
  }
  if (!fields.length) return;
  values.push(id);
  db.prepare(`UPDATE execution_agents SET ${fields.join(", ")} WHERE id = ?`).run(...(values as Array<string | number | null>));
}
export function addExecutionEvent(
  runId: string,
  area: string,
  kind: string,
  message: string,
  agentRunId: string | null = null
): void {
  db.prepare(`
    INSERT INTO execution_events (run_id, agent_run_id, created_at, area, kind, message)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(runId, agentRunId, new Date().toISOString(), area, kind, message.slice(0, 12000));
}
export function createExecutionDecision(decision: Omit<ExecutionDecisionRecord, "status" | "response" | "createdAt" | "resolvedAt">): void {
  db.prepare(`
    INSERT OR IGNORE INTO execution_decisions
      (id, run_id, agent_run_id, engine, engine_session_id, engine_request_id, kind, title, description, details_json, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    decision.id, decision.runId, decision.agentRunId, decision.engine,
    decision.engineSessionId, decision.engineRequestId, decision.kind,
    decision.title.slice(0, 500), decision.description.slice(0, 8000),
    JSON.stringify(decision.details ?? {}), new Date().toISOString()
  );
}
/** Atomically reserve a pending decision so simultaneous UI submissions cannot answer it twice. */
export function claimExecutionDecision(id: string): boolean {
  const result = db.prepare(`
    UPDATE execution_decisions SET status = 'responding'
    WHERE id = ? AND status = 'pending'
  `).run(id);
  return Number(result.changes) === 1;
}

/** Return a failed claim to the queue only when the engine did not consume the request. */
export function releaseExecutionDecisionClaim(id: string): boolean {
  const result = db.prepare(`
    UPDATE execution_decisions SET status = 'pending'
    WHERE id = ? AND status = 'responding'
  `).run(id);
  return Number(result.changes) === 1;
}

export function resolveExecutionDecision(
  id: string,
  status: Exclude<ExecutionDecisionStatus, "pending" | "responding">,
  response: string
): boolean {
  const result = db.prepare(`
    UPDATE execution_decisions SET status = ?, response = ?, resolved_at = ?
    WHERE id = ? AND status IN ('pending', 'responding')
  `).run(status, response.slice(0, 12000), new Date().toISOString(), id);
  return Number(result.changes) === 1;
}
export function getExecutionDecision(id: string): ExecutionDecisionRecord | null {
  const row = db.prepare(`
    SELECT id, run_id AS runId, agent_run_id AS agentRunId, engine,
      engine_session_id AS engineSessionId, engine_request_id AS engineRequestId,
      kind, title, description, details_json AS detailsJson, status, response,
      created_at AS createdAt, resolved_at AS resolvedAt
    FROM execution_decisions WHERE id = ?
  `).get(id) as (Record<string, unknown> & { detailsJson: string }) | undefined;
  if (!row) return null;
  return { ...row, details: JSON.parse(row.detailsJson) } as unknown as ExecutionDecisionRecord;
}
export function getExecutionSnapshot(runId: string): ExecutionSnapshot | null {
  const runRow = db.prepare(`
    SELECT id, project_path AS projectPath, instructions, status,
      started_at AS startedAt, updated_at AS updatedAt, finished_at AS finishedAt,
      summary_json AS summaryJson, thread_id AS threadId, round_number AS roundNumber,
      configuration_snapshot_json AS configurationSnapshotJson,
      continuity_context AS continuityContext
    FROM execution_runs WHERE id = ?
  `).get(runId) as (Omit<ExecutionRunRecord, "summary" | "configurationSnapshot"> & {
    summaryJson: string | null; configurationSnapshotJson: string | null
  }) | undefined;
  if (!runRow) return null;
  const run: ExecutionRunRecord = {
    id: runRow.id, threadId: runRow.threadId ?? null, roundNumber: runRow.roundNumber ?? 1,
    configurationSnapshot: runRow.configurationSnapshotJson
      ? JSON.parse(runRow.configurationSnapshotJson) as ExecutionConfigurationSnapshot : null,
    continuityContext: runRow.continuityContext ?? "",
    projectPath: runRow.projectPath, instructions: runRow.instructions, status: runRow.status,
    startedAt: runRow.startedAt, updatedAt: runRow.updatedAt, finishedAt: runRow.finishedAt,
    summary: runRow.summaryJson ? JSON.parse(runRow.summaryJson) as ExecutionSummary : null
  };
  const agents = db.prepare(`
    SELECT id, run_id AS runId, agent_id AS agentId, engine, model_id AS modelId,
      permission_profile AS permissionProfile, status, session_id AS sessionId,
      process_id AS processId, error, started_at AS startedAt, finished_at AS finishedAt,
      handoff_in_json AS handoffInJson, handoff_out_json AS handoffOutJson,
      handoff_output_meta_json AS handoffOutputMetaJson
    FROM execution_agents WHERE run_id = ? ORDER BY rowid
  `).all(runId) as Array<Record<string, unknown> & { handoffInJson: string | null; handoffOutJson: string | null; handoffOutputMetaJson: string | null }>;
  const normalizedAgents = agents.map((row) => ({
    id: String(row.id), runId: String(row.runId), agentId: String(row.agentId), engine: row.engine as EngineId,
    modelId: String(row.modelId), permissionProfile: row.permissionProfile as PermissionProfile,
    status: row.status as ExecutionAgentStatus, sessionId: row.sessionId as string | null,
    processId: row.processId as number | null, error: row.error as string | null,
    startedAt: row.startedAt as string | null, finishedAt: row.finishedAt as string | null,
    handoffIn: row.handoffInJson ? JSON.parse(row.handoffInJson) as HandoffDescriptor[] : [],
    handoffOut: row.handoffOutJson ? JSON.parse(row.handoffOutJson) as HandoffDescriptor[] : [],
    handoffOutput: row.handoffOutputMetaJson
      ? JSON.parse(row.handoffOutputMetaJson) as HandoffOutputMetadata
      : null
  }));
  const events = db.prepare(`
    SELECT id, run_id AS runId, agent_run_id AS agentRunId, created_at AS createdAt,
      area, kind, message
    FROM execution_events
    WHERE run_id = ? AND (
      id IN (
        SELECT id FROM execution_events
        WHERE run_id = ? ORDER BY id DESC LIMIT 300
      ) OR
      message LIKE '%Permiso aprobado automáticamente por Auditor%' OR
      message LIKE '%Autorización temporal aplicada automáticamente durante esta ejecución:%' OR
      message LIKE '%Autorización temporal reutilizada para la misma operación%' OR
      message LIKE '%Autorización temporal reutilizada durante esta ejecución por el mismo agente:%' OR
      message LIKE '%Autorización limitada a esta ejecución:%' OR
      message LIKE '%Autorización limitada a la misma operación%' OR
      message LIKE '%Solicitud atendida:%' OR
      message LIKE '%Solicitud pendiente:%' OR
      message LIKE '%Solicitud rechazada%' OR
      message LIKE '%rechazó las demás solicitudes%' OR
      area = 'AUDITOR'
    )
    ORDER BY id ASC
  `).all(runId, runId) as unknown as ExecutionEventRecord[];
  const decisionRows = db.prepare(`
    SELECT id, run_id AS runId, agent_run_id AS agentRunId, engine,
      engine_session_id AS engineSessionId, engine_request_id AS engineRequestId,
      kind, title, description, details_json AS detailsJson, status, response,
      created_at AS createdAt, resolved_at AS resolvedAt
    FROM execution_decisions WHERE run_id = ? ORDER BY created_at
  `).all(runId) as Array<Record<string, unknown> & { detailsJson: string }>;
  const decisionHistory = decisionRows.map((row) => ({
    ...row, details: JSON.parse(row.detailsJson)
  })) as unknown as ExecutionDecisionRecord[];
  return {
    run,
    agents: normalizedAgents,
    events,
    decisions: decisionHistory.filter((item) => item.status === "pending" || item.status === "responding"),
    decisionHistory
  };
}
/**
 * Returns the complete approval/audit ledger for a run. This is intentionally
 * independent of getExecutionSnapshot(), whose event list is capped for UI polling.
 * Do not add a LIMIT here: missing approval evidence changes the security verdict.
 */
export function getExecutionShellToolEvents(runId: string): ExecutionEventRecord[] {
  return db.prepare(`
    SELECT id, run_id AS runId, agent_run_id AS agentRunId, created_at AS createdAt,
      area, kind, message
    FROM execution_events
    -- Native tool receipts are emitted as a canonical event prefix. Do not
    -- match handoff prose that merely mentions shell or resultado-shell.
    WHERE run_id = ? AND message LIKE 'TOOL shell · %'
    ORDER BY id ASC
  `).all(runId) as unknown as ExecutionEventRecord[];
}

export function getExecutionApprovalEvents(runId: string): ExecutionEventRecord[] {
  return db.prepare(`
    SELECT id, run_id AS runId, agent_run_id AS agentRunId, created_at AS createdAt,
      area, kind, message
    FROM execution_events
    WHERE run_id = ? AND (
      message LIKE '%Permiso aprobado automáticamente por Auditor%' OR
      message LIKE '%Autorización temporal aplicada automáticamente durante esta ejecución:%' OR
      message LIKE '%Autorización temporal reutilizada para la misma operación%' OR
      message LIKE '%Autorización temporal reutilizada durante esta ejecución por el mismo agente:%' OR
      message LIKE '%Autorización limitada a esta ejecución:%' OR
      message LIKE '%Autorización limitada a la misma operación%' OR
      message LIKE '%Solicitud atendida:%' OR
      message LIKE '%Solicitud pendiente:%' OR
      message LIKE '%Solicitud rechazada%' OR
      message LIKE '%rechazó las demás solicitudes%'
    )
    ORDER BY id ASC
  `).all(runId) as unknown as ExecutionEventRecord[];
}

export function getExecutionAgentHandoffOutput(runId: string, agentRunId: string): HandoffOutputRecord | null {
  const row = db.prepare(
    "SELECT handoff_output_json AS handoffOutputJson FROM execution_agents WHERE run_id = ? AND id = ?"
  ).get(runId, agentRunId) as { handoffOutputJson: string | null } | undefined;
  return row?.handoffOutputJson
    ? JSON.parse(row.handoffOutputJson) as HandoffOutputRecord
    : null;
}

/** Repair only the old metrics-only summaries of finished runs. Original
 * reports, timestamps, verdicts and approval/security ledger remain intact.
 * Update the persisted chat response atomically with the summary; idempotent. */
export function recoverMetricsOnlySummaries(): number {
  const candidates = db.prepare("SELECT id FROM execution_runs WHERE status IN ('succeeded','failed') AND summary_json LIKE '%Se completaron % agentes registrados. Se entregaron % handoffs.%'").all() as { id: string }[];
  let recovered = 0;
  for (const { id } of candidates) {
    const snapshot = getExecutionSnapshot(id);
    const prior = snapshot?.run.summary;
    if (!snapshot || !prior || prior.generatedBy !== "orchestrator" ||
        !/^Se completaron \d+ de \d+ agentes registrados\. Se entregaron \d+ handoffs\./.test(prior.overview) ||
        prior.findings?.length || prior.nextSteps?.length ||
        prior.overview.includes("No se dispone de un informe")) continue;
    const results: AgentResult[] = [];
    for (const agent of snapshot.agents) {
      if (agent.status !== "succeeded") continue;
      const record = getExecutionAgentHandoffOutput(id, agent.id);
      if (!record) continue;
      results.push({ agentRunId: agent.id, agentId: agent.agentId, engine: agent.engine,
        modelId: agent.modelId, sessionId: agent.sessionId, status: agent.status,
        startedAt: agent.startedAt, finishedAt: agent.finishedAt, handoffId: createHandoffId(agent.agentId, id),
        output: record.content, handoffOutput: record });
    }
    if (!results.length) continue;
    const rebuilt = buildExecutionSummary({ instructions: snapshot.run.instructions, agents: snapshot.agents, results });
    if (!rebuilt.overview || rebuilt.overview.startsWith("Se completaron ")) continue;
    const summary: ExecutionSummary = { ...prior, overview: rebuilt.overview,
      findings: rebuilt.findings, nextSteps: rebuilt.nextSteps };
    const response = formatRoundSummaryMessage(snapshot.run.roundNumber,
      snapshot.run.status === "failed" ? "Terminada con errores" : "Completada", summary);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE execution_runs SET summary_json = ? WHERE id = ?").run(JSON.stringify(summary), id);
      db.prepare("UPDATE work_messages SET content = ? WHERE run_id = ? AND role = 'assistant' AND kind = 'round-summary' AND instr(content, ?) > 0")
        .run(response.slice(0, 30000), id, prior.overview);
      addExecutionEvent(id, "EXECUTIVE-SUMMARY", "info",
        "Resumen histórico recuperado de informes persistidos; no se reejecutaron agentes ni se alteró el veredicto original.");
      db.exec("COMMIT");
      recovered++;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return recovered;
}

export function getLatestExecutionId(): string | null {
  const row = db.prepare("SELECT id FROM execution_runs ORDER BY started_at DESC LIMIT 1").get() as { id: string } | undefined;
  return row?.id ?? null;
}
export function orphanExecutionDecisions(runId: string): void {
  db.prepare("UPDATE execution_decisions SET status = 'orphaned', resolved_at = ? WHERE run_id = ? AND status IN ('pending', 'responding')")
    .run(new Date().toISOString(), runId);
}

export function orphanExecutionDecisionsForAgent(runId: string, agentRunId: string): void {
  db.prepare("UPDATE execution_decisions SET status = 'orphaned', resolved_at = ? WHERE run_id = ? AND agent_run_id = ? AND status IN ('pending', 'responding')")
    .run(new Date().toISOString(), runId, agentRunId);
}

export function markUnfinishedExecutionsInterrupted(): void {
  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    // Persist the interruption in the parent workflow before changing the run
    // status, and only for the latest unfinished round in each thread.
    db.prepare(`
      INSERT INTO work_messages (id, thread_id, run_id, round_number, role, kind, content, created_at)
      SELECT 'recovery-' || lower(hex(randomblob(16))), active.thread_id, active.id,
        active.round_number, 'system', 'execution-interrupted',
        'El servicio se reinició mientras esta ronda estaba activa. La ejecución quedó interrumpida; revisa el estado antes de continuar.',
        ?
      FROM execution_runs AS active
      WHERE active.status IN ('queued', 'running', 'waiting')
        AND active.thread_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM execution_runs AS newer
          WHERE newer.thread_id = active.thread_id
            AND newer.round_number > active.round_number
        )
    `).run(now);
    db.prepare(`
      UPDATE work_threads
      SET status = 'failed', updated_at = ?
      WHERE status = 'active' AND id IN (
        SELECT active.thread_id
        FROM execution_runs AS active
        WHERE active.status IN ('queued', 'running', 'waiting')
          AND active.thread_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM execution_runs AS newer
            WHERE newer.thread_id = active.thread_id
              AND newer.round_number > active.round_number
          )
      )
    `).run(now);
    db.prepare(`
      UPDATE execution_runs
      SET status = 'interrupted', updated_at = ?, finished_at = COALESCE(finished_at, ?)
      WHERE status IN ('queued', 'running', 'waiting')
    `).run(now, now);
    db.prepare(`
      UPDATE execution_agents
      SET status = 'interrupted',
          error = COALESCE(error, 'El servicio se reinició; la sesión puede recuperarse desde el motor.'),
          finished_at = COALESCE(finished_at, ?)
      WHERE status IN ('queued', 'running', 'waiting')
    `).run(now);
    db.prepare(`
      UPDATE execution_decisions
      SET status = 'orphaned',
          response = COALESCE(response, 'La solicitud quedó huérfana porque el servicio se reinició.'),
          resolved_at = COALESCE(resolved_at, ?)
      WHERE status IN ('pending', 'responding')
    `).run(now);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}


export interface WorkThreadSnapshot {
  thread: WorkThreadRecord;
  messages: WorkMessageRecord[];
  instructionFiles: InstructionFileMetadata[];
  rounds: ExecutionSnapshot[];
}

export function createWorkThread(thread: Pick<WorkThreadRecord, "id" | "projectPath" | "objective">): void {
  const limitError = workInstructionLimitError(thread.objective);
  if (limitError) throw new RangeError(limitError);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO work_threads (id, project_path, objective, status, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?)
  `).run(thread.id, thread.projectPath, thread.objective, now, now);
}

/** Persist only approved plaintext, never truncate source instructions. */
export function saveWorkInstructionFile(
  threadId: string, roundNumber: number, file: ValidInstructionFile
): StoredInstructionFile {
  if (!Number.isSafeInteger(roundNumber) || roundNumber < 1) {
    throw new RangeError("Número de ronda inválido para el TXT.");
  }
  const countRow = db.prepare("SELECT COUNT(*) AS count FROM work_instruction_files WHERE thread_id = ?")
    .get(threadId) as { count: number };
  if (countRow.count >= MAX_FILES_PER_WORK_THREAD) {
    throw new RangeError("Este proceso alcanzó el máximo de 8 archivos TXT. Reutiliza uno anterior.");
  }
  const record: StoredInstructionFile = {
    ...file, id: randomUUID(), threadId, roundNumber, createdAt: new Date().toISOString()
  };
  db.prepare(`
    INSERT INTO work_instruction_files
      (id, thread_id, round_number, name, content, sha256, byte_length, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id, record.threadId, record.roundNumber, record.name,
    record.content, record.sha256, record.byteLength, record.createdAt
  );
  db.prepare("UPDATE work_threads SET updated_at = ? WHERE id = ?")
    .run(record.createdAt, threadId);
  return record;
}

export function listWorkInstructionFiles(threadId: string): InstructionFileMetadata[] {
  return db.prepare(`
    SELECT id, thread_id AS threadId, round_number AS roundNumber,
      name, sha256, byte_length AS byteLength, created_at AS createdAt
    FROM work_instruction_files WHERE thread_id = ? ORDER BY round_number, rowid
  `).all(threadId) as unknown as InstructionFileMetadata[];
}

export function getWorkInstructionFile(threadId: string, fileId: string): StoredInstructionFile | null {
  return db.prepare(`
    SELECT id, thread_id AS threadId, round_number AS roundNumber,
      name, content, sha256, byte_length AS byteLength, created_at AS createdAt
    FROM work_instruction_files WHERE thread_id = ? AND id = ?
  `).get(threadId, fileId) as StoredInstructionFile | undefined ?? null;
}

export function addWorkMessage(
  threadId: string,
  runId: string | null,
  roundNumber: number,
  role: WorkMessageRecord["role"],
  content: string,
  kind = "message"
): WorkMessageRecord {
  const message: WorkMessageRecord = {
    id: randomWorkMessageId(), threadId, runId, roundNumber, role, kind,
    content: content.slice(0, 30000), createdAt: new Date().toISOString()
  };
  db.prepare(`
    INSERT INTO work_messages (id, thread_id, run_id, round_number, role, kind, content, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(message.id, message.threadId, message.runId, message.roundNumber,
    message.role, message.kind, message.content, message.createdAt);
  db.prepare("UPDATE work_threads SET updated_at = ? WHERE id = ?")
    .run(message.createdAt, threadId);
  return message;
}

function randomWorkMessageId(): string {
  return randomUUID();
}

export function updateWorkThreadStatus(
  threadId: string,
  status: WorkThreadRecord["status"]
): void {
  db.prepare("UPDATE work_threads SET status = ?, updated_at = ? WHERE id = ?")
    .run(status, new Date().toISOString(), threadId);
}

export function getWorkThreadSnapshot(threadId: string): WorkThreadSnapshot | null {
  const row = db.prepare(`
    SELECT id, project_path AS projectPath, objective, status,
      created_at AS createdAt, updated_at AS updatedAt
    FROM work_threads WHERE id = ?
  `).get(threadId) as WorkThreadRecord | undefined;
  if (!row) return null;
  const messages = db.prepare(`
    SELECT id, thread_id AS threadId, run_id AS runId, round_number AS roundNumber,
      role, kind, content, created_at AS createdAt
    FROM work_messages WHERE thread_id = ? ORDER BY created_at, rowid
  `).all(threadId) as unknown as WorkMessageRecord[];
  const runIds = db.prepare(
    "SELECT id FROM execution_runs WHERE thread_id = ? ORDER BY round_number"
  ).all(threadId) as Array<{ id: string }>;
  const rounds = runIds.map((item) => getExecutionSnapshot(item.id)).filter(
    (item): item is ExecutionSnapshot => item !== null
  );
  return { thread: row, messages, instructionFiles: listWorkInstructionFiles(threadId), rounds };
}

export function getLatestWorkThreadId(): string | null {
  const row = db.prepare(`
    SELECT id FROM work_threads ORDER BY updated_at DESC, created_at DESC LIMIT 1
  `).get() as { id: string } | undefined;
  return row?.id ?? null;
}

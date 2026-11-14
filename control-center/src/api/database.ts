import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export type EngineId = "opencode" | "claude";
export type ClaudeProviderId = "apmix" | "anthropic" | "opencode-go";
export type ModelTier = "economy" | "balanced" | "premium";
export interface FavoriteModel { engine: EngineId; provider: string; modelId: string; tier: ModelTier; }
export type PermissionProfile = "read-only" | "workspace-write" | "approval-required";

export interface AgentAssignment {
  agentId: string;
  engine: EngineId;
  modelId: string;
  permissionProfile: PermissionProfile;
  enabled: boolean;
}

const stateDir = process.env.FACTORY_STATE_DIR
  ? join(process.env.FACTORY_STATE_DIR, "control-center")
  : join(homedir(), ".local", "state", "opencode-software-factory", "control-center");

mkdirSync(stateDir, { recursive: true });
const databasePath = join(stateDir, "control-center.sqlite");
const db = new DatabaseSync(databasePath);

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
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS execution_runs (
    id TEXT PRIMARY KEY,
    project_path TEXT NOT NULL,
    instructions TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    finished_at TEXT
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
    finished_at TEXT
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
  CREATE INDEX IF NOT EXISTS idx_execution_events_run ON execution_events(run_id, id);
  CREATE INDEX IF NOT EXISTS idx_execution_decisions_pending ON execution_decisions(run_id, status);
`);

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

export function listAssignments(): AgentAssignment[] {
  const rows = db.prepare(
    "SELECT agent_id, engine, model_id, permission_profile, enabled FROM agent_assignments ORDER BY agent_id"
  ).all() as Array<{
    agent_id: string;
    engine: EngineId;
    model_id: string;
    permission_profile: PermissionProfile;
    enabled: number;
  }>;

  return rows.map((row) => ({
    agentId: row.agent_id,
    engine: row.engine,
    modelId: row.model_id,
    permissionProfile: row.permission_profile,
    enabled: row.enabled === 1
  }));
}

export function saveAssignments(assignments: AgentAssignment[]): void {
  const statement = db.prepare(`
    INSERT INTO agent_assignments
      (agent_id, engine, model_id, permission_profile, enabled, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_id) DO UPDATE SET
      engine = excluded.engine,
      model_id = excluded.model_id,
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
        item.permissionProfile,
        item.enabled ? 1 : 0,
        now
      );
    }
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


export type ExecutionStatus = "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "interrupted";
export type ExecutionAgentStatus = ExecutionStatus | "skipped";
export type ExecutionDecisionStatus = "pending" | "approved" | "rejected" | "answered" | "orphaned";

export interface ExecutionRunRecord {
  id: string;
  projectPath: string;
  instructions: string;
  status: ExecutionStatus;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
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
}

export function createExecutionRecords(
  run: Omit<ExecutionRunRecord, "updatedAt" | "finishedAt">,
  agents: Array<Omit<ExecutionAgentRecord, "runId" | "sessionId" | "processId" | "error" | "startedAt" | "finishedAt">>
): void {
  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      INSERT INTO execution_runs (id, project_path, instructions, status, started_at, updated_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL)
    `).run(run.id, run.projectPath, run.instructions, run.status, run.startedAt, now);
    const insertAgent = db.prepare(`
      INSERT INTO execution_agents (id, run_id, agent_id, engine, model_id, permission_profile, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const agent of agents) {
      insertAgent.run(agent.id, run.id, agent.agentId, agent.engine, agent.modelId, agent.permissionProfile, agent.status);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
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
  patch: Partial<Pick<ExecutionAgentRecord, "status" | "sessionId" | "processId" | "error" | "startedAt" | "finishedAt">>
): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  const mapping: Record<string, string> = {
    status: "status", sessionId: "session_id", processId: "process_id", error: "error",
    startedAt: "started_at", finishedAt: "finished_at"
  };
  for (const [key, column] of Object.entries(mapping)) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      fields.push(`${column} = ?`);
      values.push((patch as Record<string, unknown>)[key]);
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
export function resolveExecutionDecision(id: string, status: Exclude<ExecutionDecisionStatus, "pending">, response: string): void {
  db.prepare(`
    UPDATE execution_decisions SET status = ?, response = ?, resolved_at = ?
    WHERE id = ? AND status = 'pending'
  `).run(status, response.slice(0, 12000), new Date().toISOString(), id);
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
      started_at AS startedAt, updated_at AS updatedAt, finished_at AS finishedAt
    FROM execution_runs WHERE id = ?
  `).get(runId) as ExecutionRunRecord | undefined;
  if (!runRow) return null;
  const agents = db.prepare(`
    SELECT id, run_id AS runId, agent_id AS agentId, engine, model_id AS modelId,
      permission_profile AS permissionProfile, status, session_id AS sessionId,
      process_id AS processId, error, started_at AS startedAt, finished_at AS finishedAt
    FROM execution_agents WHERE run_id = ? ORDER BY rowid
  `).all(runId) as unknown as ExecutionAgentRecord[];
  const events = db.prepare(`
    SELECT id, run_id AS runId, agent_run_id AS agentRunId, created_at AS createdAt,
      area, kind, message
    FROM execution_events WHERE run_id = ? ORDER BY id DESC LIMIT 300
  `).all(runId).reverse() as unknown as ExecutionEventRecord[];
  const decisions = db.prepare(`
    SELECT id, run_id AS runId, agent_run_id AS agentRunId, engine,
      engine_session_id AS engineSessionId, engine_request_id AS engineRequestId,
      kind, title, description, details_json AS detailsJson, status, response,
      created_at AS createdAt, resolved_at AS resolvedAt
    FROM execution_decisions WHERE run_id = ? AND status = 'pending' ORDER BY created_at
  `).all(runId) as Array<Record<string, unknown> & { detailsJson: string }>;
  return {
    run: runRow,
    agents,
    events,
    decisions: decisions.map((row) => ({ ...row, details: JSON.parse(row.detailsJson) })) as unknown as ExecutionDecisionRecord[]
  };
}
export function getLatestExecutionId(): string | null {
  const row = db.prepare("SELECT id FROM execution_runs ORDER BY started_at DESC LIMIT 1").get() as { id: string } | undefined;
  return row?.id ?? null;
}
export function orphanExecutionDecisions(runId: string): void {
  db.prepare("UPDATE execution_decisions SET status = 'orphaned', resolved_at = ? WHERE run_id = ? AND status = 'pending'")
    .run(new Date().toISOString(), runId);
}

export function orphanExecutionDecisionsForAgent(runId: string, agentRunId: string): void {
  db.prepare("UPDATE execution_decisions SET status = 'orphaned', resolved_at = ? WHERE run_id = ? AND agent_run_id = ? AND status = 'pending'")
    .run(new Date().toISOString(), runId, agentRunId);
}

export function markUnfinishedExecutionsInterrupted(): void {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE execution_runs SET status = 'interrupted', updated_at = ?, finished_at = ?
    WHERE status IN ('queued', 'running', 'waiting')
  `).run(now, now);
  db.prepare(`
    UPDATE execution_agents SET status = 'interrupted', error = COALESCE(error, 'El servicio se reinició; la sesión puede recuperarse desde el motor.')
    WHERE status IN ('queued', 'running', 'waiting')
  `).run();
  db.prepare("UPDATE execution_decisions SET status = 'orphaned' WHERE status = 'pending'").run();
}

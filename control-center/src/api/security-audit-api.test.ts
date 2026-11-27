import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { DatabaseSync } from "node:sqlite";
import {
  registerSecurityAuditRoutes,
  SECURITY_AUDIT_PENDING_CANCEL_TTL_MS,
  SECURITY_AUDIT_PREPARING_TTL_MS,
  SECURITY_AUDIT_REPORT_ARTIFACTS,
  isSecurityAuditPendingCancel,
  isSecurityAuditPreparing,
  markSecurityAuditPendingCancel,
  markSecurityAuditPreparing,
  type SecurityAuditApiDeps,
} from "./security-audit-api.js";
import { buildSecurityAuditRemediationPayload } from "../web/security-operations.js";
import {
  createSecurityAuditRemediation,
  createSecurityAuditRun,
  finishSecurityAuditInvocation,
  getSecurityAuditRun,
  initializeSecurityAuditSchema,
  isSecurityAuditCancelRequested,
  listSecurityAuditRemediations,
  listSecurityAuditFindings,
  reconcileSecurityAuditFindingsProjection,
  recordSecurityAuditCheckpoint,
  recordSecurityAuditCrossEngineEvidence,
  recordSecurityAuditInvocation,
  saveSecurityAuditWorkState,
  setSecurityAuditPhase,
  setSecurityAuditValidators,
  updateSecurityAuditRunStatus,
  upsertSecurityAuditFinding,
  upsertSecurityAuditUnits,
  type SecurityAuditWorkStateSnapshot,
} from "./security-audit-persistence.js";
import {
  createSecurityAuditRunDirectory,
  securityAuditsRoot,
  writeSecurityAuditArchitecture,
  writeSecurityAuditRunMetadata,
  writeSecurityAuditSourceSnapshot,
} from "./security-audit-artifacts.js";

const isolated = mkdtempSync(join(tmpdir(), "factory-security-audit-api-"));
const previousStateDir = process.env.FACTORY_STATE_DIR;
process.env.FACTORY_STATE_DIR = isolated;

const FIXTURE_DIR = fileURLToPath(new URL("./test-fixtures/security-audit/", import.meta.url));

let databaseCounter = 0;

interface FakeCall {
  type: "start" | "cancel";
  projectPath: string;
  instructions: string;
  options?: Parameters<SecurityAuditApiDeps["startExecution"]>[4];
  runId?: string;
}

interface FakeHarness {
  app: Fastify.FastifyInstance;
  db: DatabaseSync;
  calls: FakeCall[];
  setPreflight: (value: unknown) => void;
  setExecution: (value: unknown) => void;
  setExecutionFor: (runId: string, value: unknown) => void;
  setAssignments: (value: unknown[]) => void;
}

function makeHarness(): FakeHarness {
  databaseCounter += 1;
  const db = new DatabaseSync(join(isolated, `api-${databaseCounter}.sqlite`));
  initializeSecurityAuditSchema(db);
  // La tabla real de ejecuciones existe en producción; se recrea aquí para
  // poder resolver el vínculo auditoría ↔ ejecución.
  db.exec(`CREATE TABLE IF NOT EXISTS execution_runs (
    id TEXT PRIMARY KEY,
    project_path TEXT NOT NULL,
    instructions TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    finished_at TEXT,
    summary_json TEXT,
    thread_id TEXT,
    round_number INTEGER NOT NULL DEFAULT 1,
    configuration_snapshot_json TEXT,
    continuity_context TEXT
  )`);

  const calls: FakeCall[] = [];
  const executionsByRunId = new Map<string, unknown>();
  let preflight: unknown = {
    path: "/srv/example",
    decision: "accepted",
    teamSaved: true,
    consumed: false,
    preconsultedAt: "2026-01-01T00:00:00.000Z",
    analysis: {},
  };
  let execution: unknown = null;
  let assignments: unknown[] = [
    "architect", "build", "implementer", "reviewer", "tester", "reverse", "cloud-arbiter",
  ].map((agentId) => ({
    agentId,
    engine: agentId === "reviewer" || agentId === "tester" ? "claude" : "opencode",
    modelId: agentId === "reviewer" || agentId === "tester"
      ? "anthropic/claude-sonnet-4-5"
      : "opencode-go/mimo-v2.6-flash",
    permissionMode: "automatic",
    permissionProfile: "read-only",
    enabled: true,
  }));

  const deps: SecurityAuditApiDeps = {
    factoryRoot: "/factory",
    startExecution: async (projectPath, instructions, _factoryRoot, _depth, options) => {
      calls.push({ type: "start", projectPath, instructions, options });
      const runId = `exec-${calls.length}`;
      // La fila real existe en producción; aquí se recrea para respetar la FK
      // de security_audit_remediations y el vínculo de reanudación.
      const resumeRunId = options?.securityAudit?.resumeRunId ?? null;
      db.prepare(
        `INSERT INTO execution_runs
           (id, project_path, instructions, status, started_at, updated_at, configuration_snapshot_json)
         VALUES (?, ?, ?, 'queued', ?, ?, ?)`,
      ).run(
        runId,
        projectPath,
        instructions,
        new Date().toISOString(),
        new Date().toISOString(),
        JSON.stringify({ securityAudit: { resumeRunId } }),
      );
      return { runId };
    },
    cancelExecution: async (runId) => {
      calls.push({ type: "cancel", projectPath: "", instructions: "", runId });
    },
    analyzeProject: async (path) => ({ path }),
    getProjectPreflight: () => preflight as never,
    consumeProjectPreflight: () => {
      if (preflight && typeof preflight === "object") {
        preflight = { ...(preflight as Record<string, unknown>), consumed: true };
      }
      return { consumed: true };
    },
    listAssignments: () => assignments as never,
    listFavoriteModels: () => [
      { engine: "opencode", provider: "opencode", modelId: "opencode-go/mimo-v2.6-flash", tier: "balanced" },
      { engine: "claude", provider: "anthropic", modelId: "anthropic/claude-sonnet-4-5", tier: "balanced" },
    ],
    getClaudeProviderPreference: () => "anthropic",
    getExecution: (runId) => {
      // F09: las revalidaciones consultan la ejecución de la remediación por
      // su id; el resto de llamadas conserva el comportamiento previo.
      const specific = executionsByRunId.get(runId);
      if (specific !== undefined) return specific as never;
      return execution as never;
    },
    getFactoryDatabase: () => db,
    listSecurityAuditExecutionRunIds: (runId) => {
      const rows = db
        .prepare(
          "SELECT id FROM execution_runs WHERE id = ? OR configuration_snapshot_json LIKE ? " +
            "ORDER BY started_at ASC, id ASC",
        )
        .all(runId, "%" + JSON.stringify(runId) + "%") as unknown as Array<{ id: string }>;
      return rows.map((row) => row.id);
    },
    validateCapabilityScopeInput: () => ({ declarations: "alcance declarado" }),
    workInstructionLimitError: () => null,
  };

  const app = Fastify({ logger: false });
  registerSecurityAuditRoutes(app, deps);

  return {
    app,
    db,
    calls,
    setPreflight: (value) => { preflight = value; },
    setExecution: (value) => { execution = value; },
    setExecutionFor: (runId, value) => { executionsByRunId.set(runId, value); },
    setAssignments: (value) => { assignments = value; },
  };
}

const harnesses: FakeHarness[] = [];
function harness(): FakeHarness {
  const created = makeHarness();
  harnesses.push(created);
  return created;
}

after(async () => {
  for (const item of harnesses) await item.app.close();
  if (previousStateDir === undefined) delete process.env.FACTORY_STATE_DIR;
  else process.env.FACTORY_STATE_DIR = previousStateDir;
  rmSync(isolated, { recursive: true, force: true });
});

function seedRun(
  db: DatabaseSync,
  runId: string,
  overrides: Partial<Parameters<typeof createSecurityAuditRun>[1]> = {},
) {
  return createSecurityAuditRun(db, {
    runId,
    projectPath: "/srv/example",
    sourceRef: "abc123",
    sourceDirty: false,
    profile: "standard",
    intent: "full_audit",
    scope: { kind: "project" },
    budgetConfig: { maxInvocations: 20, maxConcurrency: 1, maxDurationMs: 600000 },
    outputDir: join(isolated, "output", runId),
    ...overrides,
  });
}

test("intent classification never creates directories, files or audit runs", async () => {
  const root = securityAuditsRoot();
  const before = existsSync(root);
  const h = harness();

  const guidance = await h.app.inject({
    method: "POST",
    url: "/api/security-audit/intent",
    payload: { text: "¿Qué es una validación de dependencias?" },
  });
  assert.equal(guidance.statusCode, 200);
  const guidanceBody = guidance.json() as Record<string, unknown>;
  assert.equal(guidanceBody.intent, "guidance");
  assert.equal(guidanceBody.createsArtifacts, false);
  assert.equal(guidanceBody.sixPhasePlan, false);
  assert.equal(guidanceBody.artifactsCreated, false);

  const fullAudit = await h.app.inject({
    method: "POST",
    url: "/api/security-audit/intent",
    payload: { text: "haz una auditoría completa del repositorio" },
  });
  const fullBody = fullAudit.json() as Record<string, unknown>;
  assert.equal(fullBody.intent, "full_audit");
  assert.equal(fullBody.sixPhasePlan, true);

  const ambiguous = await h.app.inject({
    method: "POST",
    url: "/api/security-audit/intent",
    payload: { text: "revisa la seguridad del proyecto" },
  });
  const ambiguousBody = ambiguous.json() as Record<string, unknown>;
  assert.equal(ambiguousBody.intent, "guidance");
  assert.equal(ambiguousBody.requiresClarification, true);

  assert.equal(existsSync(root), before, "guidance no crea la raíz de auditorías");
  assert.equal(h.calls.length, 0, "la clasificación no inicia ejecuciones");

  const empty = await h.app.inject({
    method: "POST",
    url: "/api/security-audit/intent",
    payload: { text: "   " },
  });
  assert.equal(empty.statusCode, 400);
});

test("starting an audit validates admission, team and contracts before any execution", async () => {
  const h = harness();
  const base = {
    path: "/srv/example",
    profile: "standard",
    scope: { kind: "project" },
    budget: { maxInvocations: 20, maxConcurrency: 2, maxDurationMs: 600000 },
    preflightDepth: "focused",
  };

  const ok = await h.app.inject({ method: "POST", url: "/api/security-audit/runs", payload: base });
  assert.equal(ok.statusCode, 202, ok.body);
  const startCall = h.calls.find((call) => call.type === "start");
  assert.ok(startCall, "se inició una ejecución real");
  const securityAudit = startCall?.options?.securityAudit as Record<string, unknown> | undefined;
  assert.ok(securityAudit, "la ejecución recibe la modalidad securityAudit");
  assert.equal(securityAudit?.profile, "standard");
  const scope = securityAudit?.scope as { kind: string; scopePaths: string[]; domains: string[] };
  assert.equal(scope.kind, "project");
  assert.deepEqual(scope.scopePaths, []);
  assert.deepEqual(scope.domains, []);
  assert.deepEqual(securityAudit?.budget, base.budget);

  // Cada caso negativo parte de una preconsulta vigente sin consumir.
  const freshPreflight = () => h.setPreflight({
    path: "/srv/example", decision: "accepted", teamSaved: true,
    consumed: false, preconsultedAt: "2026-01-01T00:00:00.000Z", analysis: {},
  });

  const relativePath = await h.app.inject({
    method: "POST", url: "/api/security-audit/runs", payload: { ...base, path: "ruta/relativa" },
  });
  assert.equal(relativePath.statusCode, 400);

  freshPreflight();
  const badDepth = await h.app.inject({
    method: "POST", url: "/api/security-audit/runs", payload: { ...base, preflightDepth: "otra" },
  });
  assert.equal(badDepth.statusCode, 400);

  freshPreflight();
  const badProfile = await h.app.inject({
    method: "POST", url: "/api/security-audit/runs", payload: { ...base, profile: "ultra" },
  });
  assert.equal(badProfile.statusCode, 400);

  freshPreflight();
  const traversal = await h.app.inject({
    method: "POST",
    url: "/api/security-audit/runs",
    payload: { ...base, scope: { kind: "directory", scopePaths: ["../../etc"] } },
  });
  assert.equal(traversal.statusCode, 400);

  // Equipo insuficiente para standard (falta Cloud Arbiter).
  freshPreflight();
  h.setAssignments([
    { agentId: "architect", engine: "opencode", modelId: "opencode-go/mimo-v2.6-flash", permissionMode: "automatic", permissionProfile: "read-only", enabled: true },
    { agentId: "reverse", engine: "opencode", modelId: "opencode-go/mimo-v2.6-flash", permissionMode: "automatic", permissionProfile: "read-only", enabled: true },
    { agentId: "reviewer", engine: "claude", modelId: "anthropic/claude-sonnet-4-5", permissionMode: "automatic", permissionProfile: "read-only", enabled: true },
    { agentId: "build", engine: "claude", modelId: "anthropic/claude-sonnet-4-5", permissionMode: "automatic", permissionProfile: "read-only", enabled: true },
    { agentId: "tester", engine: "claude", modelId: "anthropic/claude-sonnet-4-5", permissionMode: "automatic", permissionProfile: "read-only", enabled: true },
  ]);
  const noArbiter = await h.app.inject({ method: "POST", url: "/api/security-audit/runs", payload: base });
  assert.equal(noArbiter.statusCode, 409);
  assert.match((noArbiter.json() as { error: string }).error, /cloud-arbiter/);
  assert.equal(h.calls.filter((call) => call.type === "start").length, 1, "sin ejecución extra");
});

test("starting an audit enforces favorites and preflight like regular executions", async () => {
  const h = harness();
  const base = {
    path: "/srv/example", profile: "quick", scope: { kind: "project" }, preflightDepth: "quick",
  };

  h.setAssignments([
    { agentId: "architect", engine: "opencode", modelId: "opencode-go/modelo-no-favorito", permissionMode: "automatic", permissionProfile: "read-only", enabled: true },
  ]);
  const nonFavorite = await h.app.inject({ method: "POST", url: "/api/security-audit/runs", payload: base });
  assert.equal(nonFavorite.statusCode, 409);
  assert.match((nonFavorite.json() as { error: string }).error, /favorito/);

  h.setAssignments([
    { agentId: "architect", engine: "opencode", modelId: "opencode-go/mimo-v2.6-flash", permissionMode: "automatic", permissionProfile: "read-only", enabled: true },
    { agentId: "reverse", engine: "opencode", modelId: "opencode-go/mimo-v2.6-flash", permissionMode: "automatic", permissionProfile: "read-only", enabled: true },
    { agentId: "reviewer", engine: "claude", modelId: "anthropic/claude-sonnet-4-5", permissionMode: "automatic", permissionProfile: "read-only", enabled: true },
    { agentId: "build", engine: "opencode", modelId: "opencode-go/mimo-v2.6-flash", permissionMode: "automatic", permissionProfile: "read-only", enabled: true },
    { agentId: "tester", engine: "claude", modelId: "anthropic/claude-sonnet-4-5", permissionMode: "automatic", permissionProfile: "read-only", enabled: true },
  ]);

  h.setPreflight(null);
  const noPreflight = await h.app.inject({ method: "POST", url: "/api/security-audit/runs", payload: base });
  assert.equal(noPreflight.statusCode, 409);
  assert.match((noPreflight.json() as { error: string }).error, /preconsulta/);

  h.setPreflight({ path: "/srv/example", decision: null, teamSaved: true, consumed: false, preconsultedAt: "", analysis: {} });
  const noDecision = await h.app.inject({ method: "POST", url: "/api/security-audit/runs", payload: base });
  assert.equal(noDecision.statusCode, 409);

  h.setPreflight({ path: "/srv/example", decision: "accepted", teamSaved: false, consumed: false, preconsultedAt: "", analysis: {} });
  const noTeam = await h.app.inject({ method: "POST", url: "/api/security-audit/runs", payload: base });
  assert.equal(noTeam.statusCode, 409);
  assert.match((noTeam.json() as { error: string }).error, /Guarda el equipo/);

  h.setPreflight({ path: "/srv/example", decision: "accepted", teamSaved: true, consumed: true, preconsultedAt: "", analysis: {} });
  const consumed = await h.app.inject({ method: "POST", url: "/api/security-audit/runs", payload: base });
  assert.equal(consumed.statusCode, 409);
  assert.equal(h.calls.filter((call) => call.type === "start").length, 0, "ninguna ejecución sin preconsulta válida");
});

test("Paquete 7: start accepts trimmed instructions up to 8000 and rejects longer ones", async () => {
  const h = harness();
  const base = {
    path: "/srv/example",
    profile: "quick",
    scope: { kind: "project" },
    budget: { maxInvocations: 5, maxConcurrency: 1, maxDurationMs: 600000 },
    preflightDepth: "quick",
  };

  const accepted = await h.app.inject({
    method: "POST", url: "/api/security-audit/runs",
    payload: { ...base, instructions: "  Prioriza la superficie de autenticaci\u00f3n.  " },
  });
  assert.equal(accepted.statusCode, 202, accepted.body);
  const startCalls = () => h.calls.filter((call) => call.type === "start");
  assert.equal(startCalls().length, 1);
  assert.equal(startCalls()[0]?.instructions, "Prioriza la superficie de autenticaci\u00f3n.",
    "las instrucciones viajan recortadas a startExecution");

  // Exactamente 8000: aceptado.
  h.setPreflight({ path: "/srv/example", decision: "accepted", teamSaved: true, consumed: false, preconsultedAt: "", analysis: {} });
  const limit = await h.app.inject({
    method: "POST", url: "/api/security-audit/runs",
    payload: { ...base, instructions: "a".repeat(8000) },
  });
  assert.equal(limit.statusCode, 202, limit.body);
  assert.equal(startCalls().length, 2);
  assert.equal(startCalls()[1]?.instructions?.length, 8000);

  // 8001: rechazo 400 y NINGUNA ejecuci\u00f3n nueva.
  h.setPreflight({ path: "/srv/example", decision: "accepted", teamSaved: true, consumed: false, preconsultedAt: "", analysis: {} });
  const rejected = await h.app.inject({
    method: "POST", url: "/api/security-audit/runs",
    payload: { ...base, instructions: "a".repeat(8001) },
  });
  assert.equal(rejected.statusCode, 400);
  assert.match((rejected.json() as { error: string }).error, /8000/);
  assert.equal(startCalls().length, 2, "el rechazo no inicia ejecuci\u00f3n");

  // Tipo no string: rechazo 400.
  h.setPreflight({ path: "/srv/example", decision: "accepted", teamSaved: true, consumed: false, preconsultedAt: "", analysis: {} });
  const wrongType = await h.app.inject({
    method: "POST", url: "/api/security-audit/runs",
    payload: { ...base, instructions: 12345 },
  });
  assert.equal(wrongType.statusCode, 400);
  assert.equal(startCalls().length, 2);

  // Sin instrucciones: el texto por defecto oficial (nunca vac\u00edo).
  h.setPreflight({ path: "/srv/example", decision: "accepted", teamSaved: true, consumed: false, preconsultedAt: "", analysis: {} });
  const defaults = await h.app.inject({ method: "POST", url: "/api/security-audit/runs", payload: base });
  assert.equal(defaults.statusCode, 202, defaults.body);
  assert.equal(startCalls().length, 3);
  assert.equal(
    startCalls()[2]?.instructions,
    "Auditor\u00eda de seguridad completa solicitada desde Security Operations.",
  );
});

test("Paquete 7: status exposes the effective instruction recorded in the origin execution run", async () => {
  const h = harness();
  seedRun(h.db, "api-instrucciones");
  h.db.prepare(
    `INSERT INTO execution_runs (id, project_path, instructions, status, started_at, updated_at, configuration_snapshot_json)
     VALUES (?, '/srv/example', 'Instrucci\u00f3n original del operador.', 'running', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ?)`,
  ).run("exec-orig-1", JSON.stringify({ securityAudit: { resumeRunId: "api-instrucciones" } }));
  h.setExecutionFor("exec-orig-1", {
    run: { id: "exec-orig-1", status: "running", instructions: "Instrucci\u00f3n original del operador." },
    agents: [], events: [], decisions: [], decisionHistory: [],
  });

  const status = await h.app.inject({ method: "GET", url: "/api/security-audit/runs/api-instrucciones" });
  assert.equal(status.statusCode, 200);
  assert.equal(
    (status.json() as Record<string, unknown>).instructions,
    "Instrucci\u00f3n original del operador.",
  );

  // Sin ejecuci\u00f3n asociada: cadena vac\u00eda (nunca texto inventado).
  seedRun(h.db, "api-sin-exec");
  const empty = await h.app.inject({ method: "GET", url: "/api/security-audit/runs/api-sin-exec" });
  assert.equal(empty.statusCode, 200);
  assert.equal((empty.json() as Record<string, unknown>).instructions, "");
});

test("Paquete 7: resume reuses the original instruction instead of a generated one", async () => {
  const h = harness();
  seedRun(h.db, "api-resume-instr");
  h.db.prepare(
    `INSERT INTO execution_runs (id, project_path, instructions, status, started_at, updated_at, configuration_snapshot_json)
     VALUES (?, '/srv/example', 'Instrucci\u00f3n original del operador.', 'failed', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ?)`,
  ).run("exec-orig-2", JSON.stringify({ securityAudit: { resumeRunId: "api-resume-instr" } }));
  h.setExecutionFor("exec-orig-2", {
    run: { id: "exec-orig-2", status: "failed", instructions: "Instrucci\u00f3n original del operador." },
    agents: [], events: [], decisions: [], decisionHistory: [],
  });

  const resumed = await h.app.inject({
    method: "POST", url: "/api/security-audit/runs/api-resume-instr/resume", payload: {},
  });
  assert.equal(resumed.statusCode, 202, resumed.body);
  const call = h.calls.find((item) => item.type === "start");
  assert.equal(
    call?.instructions,
    "Instrucci\u00f3n original del operador.",
    "la reanudaci\u00f3n reutiliza la instrucci\u00f3n original",
  );
  assert.equal(
    (call?.instructions ?? "").includes("Reanudaci\u00f3n"),
    false,
    "nunca se sustituye por el texto de reanudaci\u00f3n",
  );

  // Sin ejecuci\u00f3n recuperable: el default oficial (nunca una instrucci\u00f3n inventada).
  seedRun(h.db, "api-resume-default");
  const fallback = await h.app.inject({
    method: "POST", url: "/api/security-audit/runs/api-resume-default/resume", payload: {},
  });
  assert.equal(fallback.statusCode, 202, fallback.body);
  const fallbackCall = h.calls.filter((item) => item.type === "start")[1];
  assert.equal(
    fallbackCall?.instructions,
    "Auditor\u00eda de seguridad completa solicitada desde Security Operations.",
  );
});

test("history and status expose real persistence data", async () => {
  const h = harness();
  seedRun(h.db, "api-run-a", { projectPath: "/srv/example" });
  seedRun(h.db, "api-run-b", { projectPath: "/srv/otro" });

  const history = await h.app.inject({
    method: "GET", url: "/api/security-audit/runs?projectPath=/srv/example",
  });
  assert.equal(history.statusCode, 200);
  const historyBody = history.json() as { runs: Array<{ runId: string }> };
  assert.deepEqual(historyBody.runs.map((run) => run.runId), ["api-run-a"]);

  const noPath = await h.app.inject({ method: "GET", url: "/api/security-audit/runs" });
  assert.equal(noPath.statusCode, 400);

  // Estado detallado con datos reales de las tablas.
  upsertSecurityAuditUnits(h.db, "api-run-a", [
    { unitId: "unit-cubierta", status: "covered", payload: {} },
    { unitId: "unit-pendiente", status: "candidate", payload: {} },
  ]);
  recordSecurityAuditInvocation(h.db, {
    instanceId: "inv-1",
    runId: "api-run-a",
    phase: 3,
    role: "candidate-verifier",
    agentId: "reviewer",
    engine: "claude",
    model: "anthropic/claude-sonnet-4-5",
    sessionId: "ses-1",
    agentRunId: "agent-run-1",
    handoffId: "HANDOFF-REVIEWER-API",
    verificationKind: "phase3",
    fingerprint: "fp-1",
    crossEnginePlanned: true,
  });
  finishSecurityAuditInvocation(h.db, "inv-1", "succeeded");
  // F06: la evidencia real de la verificación cruzada se registra tras
  // interpretar la salida; la fila inicia con veredicto false.
  recordSecurityAuditCrossEngineEvidence(h.db, "inv-1", {
    fingerprint: "fp-1",
    planned: true,
    verified: true,
    reason: null,
    discoverer: {
      instanceId: "inv-hunter",
      sessionId: "ses-hunter",
      engine: "opencode",
      model: "opencode-go/mimo-v2.6-flash",
      handoffId: "HANDOFF-REVERSE-API",
      agentRunId: "agent-run-hunter",
    },
    verifier: {
      instanceId: "inv-1",
      sessionId: "ses-1",
      engine: "claude",
      model: "anthropic/claude-sonnet-4-5",
      handoffId: "HANDOFF-REVIEWER-API",
      agentRunId: "agent-run-1",
    },
    verifiedAt: "2026-01-01T00:00:00.000Z",
  });
  upsertSecurityAuditFinding(h.db, "api-run-a", {
    fingerprint: "fp-1",
    verdict: "confirmed",
    severity: "high",
    payload: { title: "Hallazgo alto" },
  });
  upsertSecurityAuditFinding(h.db, "api-run-a", {
    fingerprint: "fp-2",
    verdict: "needs_validation",
    payload: { title: "Pendiente" },
  });
  setSecurityAuditPhase(h.db, "api-run-a", 1, "complete");
  setSecurityAuditValidators(h.db, "api-run-a", { ledger: "pass", findings: "pass" });
  recordSecurityAuditCheckpoint(h.db, "api-run-a", 1, "complete", { phase: 1 });

  const status = await h.app.inject({ method: "GET", url: "/api/security-audit/runs/api-run-a" });
  assert.equal(status.statusCode, 200);
  const body = status.json() as Record<string, any>;
  assert.equal(body.run.runId, "api-run-a");
  assert.equal(body.progress.completedPhases, 1);
  assert.equal(body.progress.phases[0].state, "complete");
  assert.equal(body.budget.spentTotal, 0);
  assert.equal(body.invocations.length, 1);
  assert.equal(body.invocations[0].agentId, "reviewer");
  assert.equal(body.invocations[0].sessionId, "ses-1");
  assert.equal(body.invocations[0].crossEngineVerified, true);
  assert.equal(body.invocations[0].crossEnginePlanned, true);
  assert.equal(body.invocations[0].fingerprint, "fp-1");
  assert.equal(body.invocations[0].crossEngineEvidence?.verified, true);
  assert.equal(body.invocations[0].crossEngineEvidence?.fingerprint, "fp-1");
  assert.equal(body.invocations[0].crossEngineEvidence?.discoverer?.engine, "opencode");
  assert.equal(body.invocations[0].crossEngineEvidence?.verifier.instanceId, "inv-1");
  assert.equal(body.invocations[0].autoReplay, false);
  assert.equal(body.coverage.unitsTotal, 2);
  assert.equal(body.coverage.byStatus.candidate, 1);
  assert.ok(body.coverage.pendingUnits.includes("unit-pendiente"));
  assert.equal(body.findings.confirmed, 1);
  assert.equal(body.findings.confirmedBySeverity.high, 1);
  assert.equal(body.findings.needsValidation, 1);
  assert.equal(body.validators.ledger, "pass");
  assert.ok(Array.isArray(body.blockers));

  const missing = await h.app.inject({ method: "GET", url: "/api/security-audit/runs/api-inexistente" });
  assert.equal(missing.statusCode, 404);
  const invalid = await h.app.inject({ method: "GET", url: "/api/security-audit/runs/ruta%2Fmala" });
  assert.equal(invalid.statusCode, 400);
});

/** work_state mínimo válido para las pruebas de proyección de estado. */
function emptyWorkState(): Omit<SecurityAuditWorkStateSnapshot, "savedAt"> {
  return {
    candidateById: {},
    discovererByFingerprint: {},
    phase3InstanceByFingerprint: {},
    quickPhase3FinalVerified: {},
    unitIdByFingerprint: {},
    findings: {},
    unvalidated: [],
    deferred: [],
    pendingReasons: [],
    cursor: 0,
    instanceCounter: 0,
    wavesStarted: 0,
    ledgerValidator: "pending",
    findingsValidator: "pending",
    consolidations: [],
    consolidatedUnitIds: {},
    startedAt: "2026-01-01T00:00:00.000Z",
    deadlineAt: "",
  };
}

// Defectos 3 y 4 de la revisión del Paquete 6.
test("phase 2 is not partial because of candidates and the primary reason always leads", async () => {
  const h = harness();
  seedRun(h.db, "api-p6-defectos");
  // Caza terminada: la única unidad pendiente es `candidate` (fase 3).
  upsertSecurityAuditUnits(h.db, "api-p6-defectos", [
    { unitId: "unit-cubierta", status: "covered", payload: {} },
    { unitId: "unit-candidato", status: "candidate", payload: {} },
  ]);
  for (let phase = 1; phase <= 6; phase += 1) {
    setSecurityAuditPhase(h.db, "api-p6-defectos", phase, "complete");
    recordSecurityAuditCheckpoint(h.db, "api-p6-defectos", phase, "complete", {});
  }
  // Cierre incomplete con primario fijado EXPLÍCITAMENTE (deadline_exceeded,
  // sin addReason equivalente en el work_state) + work_state con OTROS motivos.
  updateSecurityAuditRunStatus(h.db, "api-p6-defectos", "incomplete", "deadline_exceeded");
  saveSecurityAuditWorkState(h.db, "api-p6-defectos", {
    ...emptyWorkState(),
    pendingReasons: ["critic_budget_exhausted", "validation_budget_exhausted"],
    unvalidated: ["fp-1"],
  });

  const status = await h.app.inject({ method: "GET", url: "/api/security-audit/runs/api-p6-defectos" });
  assert.equal(status.statusCode, 200);
  const body = status.json() as {
    incompleteReasons: string[];
    phaseStates: Array<{ phase: number; state: string; reason: string | null }>;
  };
  // Defecto 4: el primario SIEMPRE está presente y primero; el resto ordenado
  // por la precedencia oficial.
  assert.deepEqual(body.incompleteReasons, [
    "deadline_exceeded",
    "validation_budget_exhausted",
    "critic_budget_exhausted",
  ]);
  // Defecto 3: con la caza terminada la fase 2 NO es parcial por candidatos;
  // la fase 3 queda bloqueada por el presupuesto de validación agotado.
  const phase2 = body.phaseStates.find((phase) => phase.phase === 2);
  const phase3 = body.phaseStates.find((phase) => phase.phase === 3);
  assert.equal(phase2?.state, "completed", phase2?.reason ?? "");
  assert.equal(phase3?.state, "blocked", phase3?.reason ?? "");
  // La forma pública de coverage.pendingUnits no cambia.
  assert.ok(body.phaseStates.length === 6);
});

test("report downloads use an allowlist and confined paths", async () => {
  const h = harness();
  seedRun(h.db, "api-reportes");
  const layout = createSecurityAuditRunDirectory("api-reportes");
  writeSecurityAuditRunMetadata(layout, {
    runId: "api-reportes",
    repo: "/srv/example",
    target: "/srv/example",
    sourceRef: "abc123",
    sourceDirty: false,
    profile: "standard",
    scope: { kind: "project" },
    budget: null,
    executionPolicy: "source-only",
    selectedCompanions: [],
    priorRunPaths: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  writeSecurityAuditArchitecture(layout, "# Arquitectura del run api-reportes\n");
  writeFileSync(join(layout.runDir, "REPORT.md"), "# Informe\n\nContenido del informe.\n", { mode: 0o600 });

  const report = await h.app.inject({
    method: "GET", url: "/api/security-audit/runs/api-reportes/reports/REPORT.md",
  });
  assert.equal(report.statusCode, 200);
  assert.match(String(report.headers["content-type"]), /text\/markdown/);
  assert.match(String(report.headers["content-disposition"]), /attachment; filename="REPORT.md"/);
  assert.match(report.body, /Contenido del informe/);

  const metadata = await h.app.inject({
    method: "GET", url: "/api/security-audit/runs/api-reportes/reports/run-metadata.json",
  });
  assert.equal(metadata.statusCode, 200);
  assert.match(String(metadata.headers["content-type"]), /application\/json/);

  for (const artifact of ["secreto.json", "package.json", "..%2F..%2Fetc%2Fpasswd", "REPORT.md.bak"]) {
    const rejected = await h.app.inject({
      method: "GET", url: `/api/security-audit/runs/api-reportes/reports/${artifact}`,
    });
    assert.equal(rejected.statusCode, 404, artifact);
  }
  assert.deepEqual([...SECURITY_AUDIT_REPORT_ARTIFACTS].sort(), [
    "FINDINGS-DETAIL.md", "NEEDS-VALIDATION.md", "REPORT.md", "architecture.md",
    "coverage-ledger.json", "findings.json", "run-metadata.json",
  ]);

  const missingRun = await h.app.inject({
    method: "GET", url: "/api/security-audit/runs/api-sin-archivos/reports/REPORT.md",
  });
  assert.equal(missingRun.statusCode, 404);
});

test("resume requires an existing incomplete run and reuses the audit id", async () => {
  const h = harness();
  seedRun(h.db, "api-resume");

  const missing = await h.app.inject({
    method: "POST", url: "/api/security-audit/runs/api-inexistente/resume", payload: {},
  });
  assert.equal(missing.statusCode, 404);

  const resumed = await h.app.inject({
    method: "POST", url: "/api/security-audit/runs/api-resume/resume", payload: {},
  });
  assert.equal(resumed.statusCode, 202, resumed.body);
  const call = h.calls.find((item) => item.type === "start");
  const options = call?.options?.securityAudit as Record<string, unknown> | undefined;
  assert.equal(options?.resumeRunId, "api-resume");
  assert.equal(options?.profile, "standard");

  setSecurityAuditPhase(h.db, "api-resume", 1, "complete");
  recordSecurityAuditCheckpoint(h.db, "api-resume", 1, "complete", {});
  setSecurityAuditPhase(h.db, "api-resume", 2, "complete");
  recordSecurityAuditCheckpoint(h.db, "api-resume", 2, "complete", {});
  setSecurityAuditPhase(h.db, "api-resume", 3, "complete");
  recordSecurityAuditCheckpoint(h.db, "api-resume", 3, "complete", {});
  setSecurityAuditPhase(h.db, "api-resume", 4, "complete");
  recordSecurityAuditCheckpoint(h.db, "api-resume", 4, "complete", {});
  setSecurityAuditPhase(h.db, "api-resume", 5, "complete");
  recordSecurityAuditCheckpoint(h.db, "api-resume", 5, "complete", {});
  setSecurityAuditPhase(h.db, "api-resume", 6, "complete");
  recordSecurityAuditCheckpoint(h.db, "api-resume", 6, "complete", {});
  setSecurityAuditValidators(h.db, "api-resume", { ledger: "pass", findings: "pass" });
  h.db.prepare(
    "UPDATE security_audit_runs SET run_status = 'complete', finished_at = ? WHERE run_id = ?",
  ).run(new Date().toISOString(), "api-resume");

  const completed = await h.app.inject({
    method: "POST", url: "/api/security-audit/runs/api-resume/resume", payload: {},
  });
  assert.equal(completed.statusCode, 409);
  assert.match((completed.json() as { error: string }).error, /completa/);
});

test("cancel reuses cancelExecution and persists the cancellation intent", async () => {
  const h = harness();
  seedRun(h.db, "api-cancel");

  const missing = await h.app.inject({
    method: "POST", url: "/api/security-audit/runs/api-inexistente/cancel", payload: {},
  });
  assert.equal(missing.statusCode, 404);

  h.db.prepare(
    `INSERT INTO execution_runs (id, project_path, instructions, status, started_at, updated_at)
     VALUES (?, '/srv/example', 'Auditoría', 'running', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  ).run("api-cancel");
  h.setExecution({
    run: { id: "api-cancel", status: "running" },
    agents: [], events: [], decisions: [], decisionHistory: [],
  });

  const cancelled = await h.app.inject({
    method: "POST", url: "/api/security-audit/runs/api-cancel/cancel", payload: {},
  });
  assert.equal(cancelled.statusCode, 200, cancelled.body);
  const cancelCall = h.calls.find((call) => call.type === "cancel");
  assert.equal(cancelCall?.runId, "api-cancel", "reutiliza el motor de cancelación");
  assert.equal(isSecurityAuditCancelRequested(h.db, "api-cancel"), true);

  h.setExecution({
    run: { id: "api-cancel", status: "succeeded" },
    agents: [], events: [], decisions: [], decisionHistory: [],
  });
  const inactive = await h.app.inject({
    method: "POST", url: "/api/security-audit/runs/api-cancel/cancel", payload: {},
  });
  assert.equal(inactive.statusCode, 409);
});

test("validation runs both official validators and persists their states", async () => {
  const h = harness();
  seedRun(h.db, "api-validar");
  const layout = createSecurityAuditRunDirectory("api-validar");
  writeFileSync(
    join(layout.runDir, "coverage-ledger.json"),
    readFileSync(join(FIXTURE_DIR, "coverage-ledger-valid.json"), "utf8"),
    { mode: 0o600 },
  );
  writeFileSync(
    join(layout.runDir, "findings.json"),
    readFileSync(join(FIXTURE_DIR, "findings-valid.json"), "utf8"),
    { mode: 0o600 },
  );

  const pass = await h.app.inject({
    method: "POST", url: "/api/security-audit/runs/api-validar/validate", payload: {},
  });
  assert.equal(pass.statusCode, 200, pass.body);
  const passBody = pass.json() as { ok: boolean; ledger: { status: string }; findings: { status: string } };
  assert.equal(passBody.ok, true);
  assert.equal(passBody.ledger.status, "PASS");
  assert.equal(passBody.findings.status, "PASS");
  assert.equal(getSecurityAuditRun(h.db, "api-validar")?.ledgerValidator, "pass");

  writeFileSync(join(layout.runDir, "findings.json"), '[{"verdict":"confirmed"}]', { mode: 0o600 });
  const fail = await h.app.inject({
    method: "POST", url: "/api/security-audit/runs/api-validar/validate", payload: {},
  });
  const failBody = fail.json() as { ok: boolean; findings: { status: string } };
  assert.equal(failBody.ok, false);
  assert.equal(failBody.findings.status, "FAIL");
  assert.equal(getSecurityAuditRun(h.db, "api-validar")?.findingsValidator, "fail");
});

test("remediation is a separate traditional execution tied to confirmed findings", async () => {
  const h = harness();
  seedRun(h.db, "api-remedio");
  upsertSecurityAuditFinding(h.db, "api-remedio", {
    fingerprint: "fp-confirmado",
    verdict: "confirmed",
    severity: "high",
    payload: { title: "Confirmado" },
  });
  upsertSecurityAuditFinding(h.db, "api-remedio", {
    fingerprint: "fp-pendiente",
    verdict: "needs_validation",
    payload: { title: "Pendiente" },
  });

  const noApproval = await h.app.inject({
    method: "POST",
    url: "/api/security-audit/runs/api-remedio/remediations",
    payload: { fingerprints: ["fp-confirmado"] },
  });
  assert.equal(noApproval.statusCode, 400);
  assert.match((noApproval.json() as { error: string }).error, /approved/);

  const notConfirmed = await h.app.inject({
    method: "POST",
    url: "/api/security-audit/runs/api-remedio/remediations",
    payload: { fingerprints: ["fp-pendiente"], approved: true },
  });
  assert.equal(notConfirmed.statusCode, 409);
  assert.match((notConfirmed.json() as { error: string }).error, /confirmed/);

  const started = await h.app.inject({
    method: "POST",
    url: "/api/security-audit/runs/api-remedio/remediations",
    payload: { fingerprints: ["fp-confirmado"], approved: true, preflightDepth: "focused" },
  });
  assert.equal(started.statusCode, 202, started.body);
  const startCall = h.calls.find((call) => call.type === "start");
  assert.ok(startCall);
  // Ejecución TRADICIONAL: sin modalidad securityAudit (permisos normales).
  assert.equal(startCall?.options?.securityAudit, undefined);
  assert.match(startCall?.instructions ?? "", /fp-confirmado/);
  assert.match(startCall?.instructions ?? "", /REMEDIACIÓN INDEPENDIENTE/);

  const remediations = listSecurityAuditRemediations(h.db, "api-remedio");
  assert.equal(remediations.length, 1);
  assert.equal(remediations[0]?.state, "in_progress");
  assert.equal(remediations[0]?.executionRunId, startCall?.runId ?? remediations[0]?.executionRunId);

  const duplicate = await h.app.inject({
    method: "POST",
    url: "/api/security-audit/runs/api-remedio/remediations",
    payload: { fingerprints: ["fp-confirmado"], approved: true, preflightDepth: "focused" },
  });
  assert.equal(duplicate.statusCode, 409);
  assert.match((duplicate.json() as { error: string }).error, /Ya existe una remediación/);

  const list = await h.app.inject({
    method: "GET", url: "/api/security-audit/runs/api-remedio/remediations",
  });
  assert.equal(list.statusCode, 200);
  assert.equal((list.json() as { remediations: unknown[] }).remediations.length, 1);
  const executionRunId = remediations[0]!.executionRunId!;
  h.setExecutionFor(executionRunId, {run:{id:executionRunId,status:"succeeded"}});
  const updated = await h.app.inject({method:"GET",url:"/api/security-audit/runs/api-remedio/remediations"});
  assert.equal(updated.statusCode,200);
  assert.equal(updated.json().remediations[0].executionStatus,"succeeded");
  assert.equal(updated.json().remediations[0].state,"in_progress");
  const status = await h.app.inject({method:"GET",url:"/api/security-audit/runs/api-remedio"});
  assert.equal(status.statusCode,200);
  assert.equal(status.json().remediations[0].executionStatus,"succeeded");
  assert.equal(status.json().remediations[0].state,"in_progress");
  assert.equal(listSecurityAuditRemediations(h.db,"api-remedio")[0]?.state,"in_progress");
});

/**
 * F07: la API solo remedia hallazgos `confirmed` ACTIVOS de la proyección.
 * Un registro retirado (conservado solo en el historial append-only) ya no es
 * remediable y no aparece en el estado publicado.
 */
test("a retired confirmed finding is no longer remediable through the API (F07)", async () => {
  const h = harness();
  seedRun(h.db, "api-retirado");
  reconcileSecurityAuditFindingsProjection(h.db, "api-retirado", {
    records: [{
      fingerprint: "fp-retirado",
      verdict: "confirmed",
      severity: "high",
      payload: { verdict: "confirmed", fingerprint: "fp-retirado", title: "Confirmado", description: "d" },
    }],
  });
  reconcileSecurityAuditFindingsProjection(h.db, "api-retirado", {
    records: [],
    retirements: new Map([["fp-retirado", "verification_unverified"]]),
    fallbackRetirementReason: "removed_from_findings_map",
  });

  const status = await h.app.inject({ method: "GET", url: "/api/security-audit/runs/api-retirado" });
  assert.equal(status.statusCode, 200);
  const findings = (status.json() as { findings: { items: Array<{ fingerprint: string }> } }).findings;
  assert.equal(findings.items.some((item) => item.fingerprint === "fp-retirado"), false,
    "el registro retirado no aparece como activo");

  const remediation = await h.app.inject({
    method: "POST",
    url: "/api/security-audit/runs/api-retirado/remediations",
    payload: { fingerprints: ["fp-retirado"], approved: true, preflightDepth: "focused" },
  });
  assert.equal(remediation.statusCode, 409);
  assert.match((remediation.json() as { error: string }).error, /confirmed/);
  assert.equal(h.calls.filter((call) => call.type === "start").length, 0,
    "nunca se inicia una remediación sobre un registro retirado");
});

/**
 * F08: la API rechaza la política sandboxed aunque el cliente envíe una
 * autorización que parecería válida: 400 con `sandbox_not_implemented`, sin
 * fallback silencioso y sin iniciar ejecución alguna.
 */
test("the start API rejects the sandboxed policy even with a seemingly valid authorization (F08)", async () => {
  const h = harness();
  const base = {
    path: "/srv/example",
    profile: "standard",
    scope: { kind: "project" },
    preflightDepth: "focused",
    executionPolicy: "sandboxed-source-and-local-only",
    sandboxAuthorization: {
      available: true,
      isolationClaim: "partial",
      blockers: ["disk_limit_unavailable", "promotion_dirfd_unavailable"],
      networkTarget: "denied",
    },
  };
  const rejected = await h.app.inject({ method: "POST", url: "/api/security-audit/runs", payload: base });
  assert.equal(rejected.statusCode, 400, rejected.body);
  assert.match((rejected.json() as { error: string }).error, /sandbox_not_implemented/);
  assert.equal(h.calls.length, 0, "ninguna ejecución iniciada con política sandboxed");
});

test("production report allowlist matches the shared artifacts", () => {
  assert.deepEqual([...SECURITY_AUDIT_REPORT_ARTIFACTS], [
    "run-metadata.json",
    "architecture.md",
    "coverage-ledger.json",
    "findings.json",
    "REPORT.md",
    "FINDINGS-DETAIL.md",
    "NEEDS-VALIDATION.md",
  ]);
});

test("M4: run ids are lowercase-canonical and artifacts are pattern checked", async () => {
  const h = harness();
  seedRun(h.db, "api-mayusculas");
  const layout = createSecurityAuditRunDirectory("api-mayusculas");
  writeFileSync(join(layout.runDir, "REPORT.md"), "# Informe\n", { mode: 0o600 });

  const upper = await h.app.inject({ method: "GET", url: "/api/security-audit/runs/API-MAYUSCULAS" });
  assert.equal(upper.statusCode, 400, "el id en mayúsculas no es canónico");
  const lower = await h.app.inject({ method: "GET", url: "/api/security-audit/runs/api-mayusculas" });
  assert.equal(lower.statusCode, 200);

  const okArtifact = await h.app.inject({
    method: "GET", url: "/api/security-audit/runs/api-mayusculas/reports/REPORT.md",
  });
  assert.equal(okArtifact.statusCode, 200);
  for (const artifact of [".hidden", "REPORT.md%20x", "..%2FREPORT.md", "REPORTMD"]) {
    const rejected = await h.app.inject({
      method: "GET", url: `/api/security-audit/runs/api-mayusculas/reports/${artifact}`,
    });
    assert.equal(rejected.statusCode, 404, artifact);
  }
});

test("M5: the UI payload contract starts an audit and remediation reuses the consumed preflight", async () => {
  const h = harness();
  seedRun(h.db, "api-ui-contrato");
  upsertSecurityAuditFinding(h.db, "api-ui-contrato", {
    fingerprint: "fp-confirmado",
    verdict: "confirmed",
    severity: "high",
    payload: { title: "Confirmado" },
  });
  // La preconsulta ya fue consumida por la auditoría original.
  h.setPreflight({
    path: "/srv/example", decision: "accepted", teamSaved: true,
    consumed: true, preconsultedAt: "2026-01-01T00:00:00.000Z", analysis: {},
  });

  const payload = buildSecurityAuditRemediationPayload({
    projectPath: "/srv/example",
    researchDepth: "deep",
    fingerprints: ["fp-confirmado"],
  });
  assert.deepEqual(Object.keys(payload).sort(), ["approved", "fingerprints", "path", "preflightDepth"]);
  assert.equal(payload.preflightDepth, "deep");

  const remediation = await h.app.inject({
    method: "POST",
    url: "/api/security-audit/runs/api-ui-contrato/remediations",
    payload,
  });
  assert.equal(remediation.statusCode, 202, remediation.body);
  const call = h.calls.find((item) => item.type === "start");
  assert.equal(call?.options?.securityRemediation?.auditRunId, "api-ui-contrato", "vínculo guardado");
  assert.deepEqual(call?.options?.securityRemediation?.fingerprints, ["fp-confirmado"]);
  assert.equal(call?.options?.securityAudit, undefined, "la remediación no usa la modalidad de auditoría");

  // La misma preconsulta consumida sigue bloqueando una auditoría normal.
  const normalAudit = await h.app.inject({
    method: "POST",
    url: "/api/security-audit/runs",
    payload: { path: "/srv/example", profile: "quick", scope: { kind: "project" }, preflightDepth: "focused" },
  });
  assert.equal(normalAudit.statusCode, 409);
  assert.match((normalAudit.json() as { error: string }).error, /preconsulta ya fue utilizada/);
});

// Evidencia sintética solo para pruebas HTTP: los hashes representan bytes
// distintos antes/después y la aceptación la registra el orquestador real.
function seedTestSourceSnapshot(runId: string, version: string): void {
  const layout = createSecurityAuditRunDirectory(runId);
  writeSecurityAuditRunMetadata(layout, {
    runId, repo: "/srv/example", target: "/srv/example", sourceRef: null,
    sourceDirty: true, profile: "standard", scope: { kind: "project" },
    budget: {}, executionPolicy: "source-only", selectedCompanions: [],
    priorRunPaths: [], createdAt: new Date().toISOString(),
  });
  const files = ["src/handler.ts", "src/model.ts"].map((path) => ({
    path, sha256: createHash("sha256").update(version + path).digest("hex"),
  }));
  writeSecurityAuditSourceSnapshot(layout, {
    files, sha256: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
  });
}

function seedAcceptedRecord(db: DatabaseSync, runId: string, instanceId: string, fingerprint: string,
    sessionId: string | null, handoffId: string | null, agentRunId: string | null): void {
  const record = listSecurityAuditFindings(db, runId).find((row) => row.fingerprint === fingerprint);
  if (!record) return;
  recordSecurityAuditCrossEngineEvidence(db, instanceId, {
    fingerprint, planned: false, verified: false, reason: "same_engine", discoverer: null,
    verifier: { instanceId, sessionId, handoffId, agentRunId, engine: "claude", model: "test-model" },
    verifiedAt: null, acceptedRecordSha256: createHash("sha256").update(JSON.stringify(record.payload)).digest("hex"),
  });
}

test("M6: verified_fixed requires a completed verification run with rejected record and phase5 evidence", async () => {
  const h = harness();
  seedTestSourceSnapshot("api-revalida-estricta", "original");
  seedTestSourceSnapshot("api-verif-ok", "corregido");
  seedRun(h.db, "api-revalida-estricta");
  // F09: hallazgo original con ubicación verificable y remediación con una
  // ejecución real terminal succeeded anterior a la verificación. La FK exige
  // la fila real de ejecución antes de crear la remediación.
  h.db.prepare(
    `INSERT INTO execution_runs
       (id, project_path, instructions, status, started_at, updated_at, finished_at)
     VALUES ('exec-remedio', '/srv/example', 'Remediación', 'succeeded', ?, ?, ?)`,
  ).run(
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:00.000Z",
  );
  upsertSecurityAuditFinding(h.db, "api-revalida-estricta", {
    fingerprint: "fp-1",
    verdict: "confirmed",
    severity: "high",
    payload: { title: "Confirmado", location: "src/handler.ts:10" },
  });
  createSecurityAuditRemediation(h.db, {
    runId: "api-revalida-estricta",
    fingerprint: "fp-1",
    executionRunId: "exec-remedio",
  });
  h.setExecutionFor("exec-remedio", {
    run: { id: "exec-remedio", status: "succeeded", finishedAt: "2026-01-01T00:00:00.000Z" },
    agents: [],
  });

  const markComplete = (runId: string) => {
    h.db.prepare(
      "UPDATE security_audit_runs SET run_status = 'complete', finished_at = ? WHERE run_id = ?",
    ).run(new Date().toISOString(), runId);
  };

  const noId = await h.app.inject({
    method: "POST",
    url: "/api/security-audit/runs/api-revalida-estricta/remediations/fp-1/revalidate",
    payload: {},
  });
  assert.equal(noId.statusCode, 400);
  assert.match((noId.json() as { error: string }).error, /verificationAuditRunId/);

  const unknownRun = await h.app.inject({
    method: "POST",
    url: "/api/security-audit/runs/api-revalida-estricta/remediations/fp-1/revalidate",
    payload: { verificationAuditRunId: "api-inexistente" },
  });
  assert.equal(unknownRun.statusCode, 409);
  assert.match((unknownRun.json() as { error: string }).error, /no existe/);

  const sameRun = await h.app.inject({
    method: "POST",
    url: "/api/security-audit/runs/api-revalida-estricta/remediations/fp-1/revalidate",
    payload: { verificationAuditRunId: "api-revalida-estricta" },
  });
  assert.equal(sameRun.statusCode, 409);

  seedRun(h.db, "api-verif-otro-proyecto", { projectPath: "/srv/otro" });
  markComplete("api-verif-otro-proyecto");
  const otherProject = await h.app.inject({
    method: "POST",
    url: "/api/security-audit/runs/api-revalida-estricta/remediations/fp-1/revalidate",
    payload: { verificationAuditRunId: "api-verif-otro-proyecto" },
  });
  assert.equal(otherProject.statusCode, 409);
  assert.match((otherProject.json() as { error: string }).error, /mismo proyecto/);

  seedRun(h.db, "api-verif-incompleto");
  const incomplete = await h.app.inject({
    method: "POST",
    url: "/api/security-audit/runs/api-revalida-estricta/remediations/fp-1/revalidate",
    payload: { verificationAuditRunId: "api-verif-incompleto" },
  });
  assert.equal(incomplete.statusCode, 409);
  assert.match((incomplete.json() as { error: string }).error, /completo/);

  seedRun(h.db, "api-verif-sin-pass");
  markComplete("api-verif-sin-pass");
  const validatorsPending = await h.app.inject({
    method: "POST",
    url: "/api/security-audit/runs/api-revalida-estricta/remediations/fp-1/revalidate",
    payload: { verificationAuditRunId: "api-verif-sin-pass" },
  });
  assert.equal(validatorsPending.statusCode, 409);
  assert.match((validatorsPending.json() as { error: string }).error, /validadores/);

  seedRun(h.db, "api-verif-sin-rejected");
  markComplete("api-verif-sin-rejected");
  setSecurityAuditValidators(h.db, "api-verif-sin-rejected", { ledger: "pass", findings: "pass" });
  upsertSecurityAuditFinding(h.db, "api-verif-sin-rejected", {
    fingerprint: "fp-1", verdict: "confirmed", payload: {},
  });
  const notRejected = await h.app.inject({
    method: "POST",
    url: "/api/security-audit/runs/api-revalida-estricta/remediations/fp-1/revalidate",
    payload: { verificationAuditRunId: "api-verif-sin-rejected" },
  });
  assert.equal(notRejected.statusCode, 409);
  assert.match((notRejected.json() as { error: string }).error, /rejected/);

  seedRun(h.db, "api-verif-sin-phase5");
  markComplete("api-verif-sin-phase5");
  setSecurityAuditValidators(h.db, "api-verif-sin-phase5", { ledger: "pass", findings: "pass" });
  upsertSecurityAuditFinding(h.db, "api-verif-sin-phase5", {
    fingerprint: "fp-1", verdict: "rejected", payload: {},
  });
  const withoutPhase5 = await h.app.inject({
    method: "POST",
    url: "/api/security-audit/runs/api-revalida-estricta/remediations/fp-1/revalidate",
    payload: { verificationAuditRunId: "api-verif-sin-phase5" },
  });
  assert.equal(withoutPhase5.statusCode, 409);
  assert.match((withoutPhase5.json() as { error: string }).error, /phase5/);

  // Ningún caso anterior marcó verified_fixed.
  assert.equal(listSecurityAuditRemediations(h.db, "api-revalida-estricta")[0]?.state, "requested");

  // Caso válido: run completo, ambos PASS, rejected, phase5 exitosa con
  // identidad real y una versión posterior del código (commit nuevo).
  seedRun(h.db, "api-verif-ok", { sourceRef: "def456" });
  markComplete("api-verif-ok");
  setSecurityAuditValidators(h.db, "api-verif-ok", { ledger: "pass", findings: "pass" });
  upsertSecurityAuditFinding(h.db, "api-verif-ok", {
    fingerprint: "fp-1", verdict: "rejected", payload: { title: "Ya no se reproduce" },
  });
  recordSecurityAuditInvocation(h.db, {
    instanceId: "phase5-ok",
    runId: "api-verif-ok",
    phase: 5,
    role: "record-verifier",
    agentId: "reviewer",
    engine: "claude",
    model: "anthropic/claude-sonnet-4-5",
    verificationKind: "phase5",
    fingerprint: "fp-1",
    crossEnginePlanned: true,
    sessionId: "sess-phase5-ok",
    handoffId: "handoff-phase5-ok",
    agentRunId: "agentrun-phase5-ok",
  });
  finishSecurityAuditInvocation(h.db, "phase5-ok", "succeeded");

  const notAccepted = await h.app.inject({
    method: "POST",
    url: "/api/security-audit/runs/api-revalida-estricta/remediations/fp-1/revalidate",
    payload: { verificationAuditRunId: "api-verif-ok" },
  });
  assert.equal(notAccepted.statusCode, 409);
  assert.match(notAccepted.body, /aceptación/);
  seedAcceptedRecord(h.db, "api-verif-ok", "phase5-ok", "fp-1", "sess-phase5-ok", "handoff-phase5-ok", "agentrun-phase5-ok");
  const valid = await h.app.inject({
    method: "POST",
    url: "/api/security-audit/runs/api-revalida-estricta/remediations/fp-1/revalidate",
    payload: { verificationAuditRunId: "api-verif-ok" },
  });
  assert.equal(valid.statusCode, 200, valid.body);
  const [remediation] = listSecurityAuditRemediations(h.db, "api-revalida-estricta");
  assert.equal(remediation?.state, "verified_fixed");
  const evidence = remediation?.evidence as Array<Record<string, unknown>>;
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]?.verificationAuditRunId, "api-verif-ok");
  assert.equal(evidence[0]?.verdict, "rejected");
  assert.deepEqual(evidence[0]?.phase5Instances, ["phase5-ok"]);
});

/**
 * F09: la revalidación exige evidencia ESPECÍFICA y verificable: fase5 del
 * fingerprint exacto con identidad real y posterior a la remediación,
 * ejecución de remediación real terminal succeeded, alcance que cubra la
 * ubicación del hallazgo original y una versión posterior del código.
 */
test("F09: revalidate demands specific phase5 evidence, a real remediation execution and a posterior code version", async () => {
  const h = harness();
  seedRun(h.db, "api-revalida-f09");
  seedTestSourceSnapshot("api-revalida-f09", "original");
  upsertSecurityAuditFinding(h.db, "api-revalida-f09", {
    fingerprint: "fp-1",
    verdict: "confirmed",
    severity: "high",
    payload: { title: "Confirmado", location: "src/handler.ts:10" },
  });
  upsertSecurityAuditFinding(h.db, "api-revalida-f09", {
    fingerprint: "fp-fuera",
    verdict: "confirmed",
    severity: "high",
    payload: { title: "Ubicación fuera del proyecto", location: "/srv/otro/src/x.ts:1" },
  });
  upsertSecurityAuditFinding(h.db, "api-revalida-f09", {
    fingerprint: "fp-3",
    verdict: "confirmed",
    severity: "medium",
    payload: { title: "Otro fichero", location: "src/model.ts:20" },
  });

  const remediation = await h.app.inject({
    method: "POST",
    url: "/api/security-audit/runs/api-revalida-f09/remediations",
    payload: { fingerprints: ["fp-1", "fp-fuera"], approved: true, preflightDepth: "focused" },
  });
  assert.equal(remediation.statusCode, 202, remediation.body);
  const remediationForFp3 = await h.app.inject({
    method: "POST",
    url: "/api/security-audit/runs/api-revalida-f09/remediations",
    payload: { fingerprints: ["fp-3"], approved: true, preflightDepth: "focused" },
  });
  assert.equal(remediationForFp3.statusCode, 202, remediationForFp3.body);

  const remediationRows = listSecurityAuditRemediations(h.db, "api-revalida-f09");
  const executionRunIdOf = (fingerprint: string): string | null =>
    remediationRows.find((item) => item.fingerprint === fingerprint)?.executionRunId ?? null;
  const executionRunIdFp1 = executionRunIdOf("fp-1");
  const executionRunIdFp3 = executionRunIdOf("fp-3");
  assert.ok(executionRunIdFp1, "la remediación de fp-1 tiene ejecución vinculada");
  assert.ok(executionRunIdFp3, "la remediación de fp-3 tiene ejecución vinculada");

  const REMEDIATION_FINISH = "2026-01-02T00:00:00.000Z";
  const markExecution = (runId: string, status: string) => {
    h.setExecutionFor(runId, {
      run: {
        id: runId,
        status,
        finishedAt: status === "succeeded" ? REMEDIATION_FINISH : null,
      },
      agents: [],
    });
  };
  markExecution(executionRunIdFp1!, "succeeded");
  markExecution(executionRunIdFp3!, "succeeded");

  const revalidate = (fingerprint: string, verificationRunId: string) =>
    h.app.inject({
      method: "POST",
      url: `/api/security-audit/runs/api-revalida-f09/remediations/${fingerprint}/revalidate`,
      payload: { verificationAuditRunId: verificationRunId },
    });

  const seedVerification = (
    runId: string,
    overrides: Partial<Parameters<typeof seedRun>[2]> = {},
  ) => {
    seedRun(h.db, runId, overrides);
    seedTestSourceSnapshot(runId, runId.endsWith("-sin-cambios") ? "original" : "corregido");
    h.db.prepare(
      "UPDATE security_audit_runs SET run_status = 'complete', finished_at = ? WHERE run_id = ?",
    ).run(new Date().toISOString(), runId);
    setSecurityAuditValidators(h.db, runId, { ledger: "pass", findings: "pass" });
    upsertSecurityAuditFinding(h.db, runId, {
      fingerprint: "fp-1",
      verdict: "rejected",
      payload: { title: "Ya no se reproduce", location: "src/handler.ts:10" },
    });
    upsertSecurityAuditFinding(h.db, runId, {
      fingerprint: "fp-fuera",
      verdict: "rejected",
      payload: { title: "Ya no se reproduce", location: "src/otro.ts:1" },
    });
    upsertSecurityAuditFinding(h.db, runId, {
      fingerprint: "fp-3",
      verdict: "rejected",
      payload: { title: "Ya no se reproduce", location: "src/model.ts:20" },
    });
  };
  const seedPhase5 = (
    runId: string,
    fingerprint: string,
    options: {
      sessionId?: string | null;
      handoffId?: string | null;
      agentRunId?: string | null;
    } = {},
  ) => {
    const instanceId = `phase5-${runId}-${fingerprint}`;
    recordSecurityAuditInvocation(h.db, {
      instanceId,
      runId,
      phase: 5,
      role: "record-verifier",
      agentId: "reviewer",
      engine: "claude",
      model: "anthropic/claude-sonnet-4-5",
      verificationKind: "phase5",
      fingerprint,
      sessionId: options.sessionId !== undefined ? options.sessionId : "sess-1",
      handoffId: options.handoffId !== undefined ? options.handoffId : "handoff-1",
      agentRunId: options.agentRunId !== undefined ? options.agentRunId : "agentrun-1",
    });
    finishSecurityAuditInvocation(h.db, instanceId, "succeeded");
    seedAcceptedRecord(h.db, runId, instanceId, fingerprint,
      options.sessionId !== undefined ? options.sessionId : "sess-1",
      options.handoffId !== undefined ? options.handoffId : "handoff-1",
      options.agentRunId !== undefined ? options.agentRunId : "agentrun-1");
  };

  // 1) La ejecución de remediación debe existir y estar terminal succeeded.
  seedVerification("api-verif-f09-failed", { sourceRef: "def456" });
  seedPhase5("api-verif-f09-failed", "fp-1");
  markExecution(executionRunIdFp1!, "failed");
  const failedExecution = await revalidate("fp-1", "api-verif-f09-failed");
  assert.equal(failedExecution.statusCode, 409, failedExecution.body);
  assert.match((failedExecution.json() as { error: string }).error, /succeeded/);
  markExecution(executionRunIdFp1!, "succeeded");

  // 2) La verificación debe ser posterior a la finalización de la remediación.
  seedVerification("api-verif-f09-antes", { sourceRef: "def456" });
  seedPhase5("api-verif-f09-antes", "fp-1");
  h.db.prepare("UPDATE security_audit_runs SET created_at = ? WHERE run_id = ?")
    .run("2026-01-01T00:00:00.000Z", "api-verif-f09-antes");
  const beforeRemediation = await revalidate("fp-1", "api-verif-f09-antes");
  assert.equal(beforeRemediation.statusCode, 409, beforeRemediation.body);
  assert.match((beforeRemediation.json() as { error: string }).error, /posterior/);

  // 3) La fase5 de OTRO hallazgo no cuenta.
  seedVerification("api-verif-f09-otro-fp", { sourceRef: "def456" });
  seedPhase5("api-verif-f09-otro-fp", "fp-otro");
  const otherFingerprint = await revalidate("fp-1", "api-verif-f09-otro-fp");
  assert.equal(otherFingerprint.statusCode, 409, otherFingerprint.body);
  assert.match((otherFingerprint.json() as { error: string }).error, /phase5/);

  // 4) Sin sesión/handoff/agentRun reales no hay evidencia atribuible.
  seedVerification("api-verif-f09-sin-sesion", { sourceRef: "def456" });
  seedPhase5("api-verif-f09-sin-sesion", "fp-1", { sessionId: null });
  const missingSession = await revalidate("fp-1", "api-verif-f09-sin-sesion");
  assert.equal(missingSession.statusCode, 409, missingSession.body);
  assert.match((missingSession.json() as { error: string }).error, /sesión/);

  // 5) La misma versión limpia del original nunca revalida.
  seedVerification("api-verif-f09-misma-version");
  seedPhase5("api-verif-f09-misma-version", "fp-1");
  const sameCleanVersion = await revalidate("fp-1", "api-verif-f09-misma-version");
  assert.equal(sameCleanVersion.statusCode, 409, sameCleanVersion.body);
  assert.match((sameCleanVersion.json() as { error: string }).error, /versión/);

  // 6) El alcance del run de verificación debe cubrir la ubicación original.
  seedVerification("api-verif-f09-alcance", {
    sourceRef: "def456",
    scope: { kind: "directory", scopePaths: ["docs"] },
  });
  seedPhase5("api-verif-f09-alcance", "fp-1");
  const wrongScope = await revalidate("fp-1", "api-verif-f09-alcance");
  assert.equal(wrongScope.statusCode, 409, wrongScope.body);
  assert.match((wrongScope.json() as { error: string }).error, /alcance/);

  // 7) Una ubicación fuera del proyecto no es verificable.
  seedVerification("api-verif-f09-fuera", { sourceRef: "def456" });
  seedPhase5("api-verif-f09-fuera", "fp-fuera");
  const outsideProject = await revalidate("fp-fuera", "api-verif-f09-fuera");
  assert.equal(outsideProject.statusCode, 409, outsideProject.body);
  assert.match((outsideProject.json() as { error: string }).error, /proyecto/);

  // Ningún caso anterior marcó verified_fixed.
  for (const row of listSecurityAuditRemediations(h.db, "api-revalida-f09")) {
    assert.notEqual(row.state, "verified_fixed", row.fingerprint);
  }

  seedVerification("api-verif-f09-sin-cambios", { sourceRef: "def456" });
  seedPhase5("api-verif-f09-sin-cambios", "fp-1");
  const unchanged = await revalidate("fp-1", "api-verif-f09-sin-cambios");
  assert.equal(unchanged.statusCode, 409);
  assert.match(unchanged.body, /contenido posterior/);

  // Caso válido con commit nuevo: sourceRef distinto y todo lo demás correcto.
  seedVerification("api-verif-f09-commit", { sourceRef: "def456" });
  seedPhase5("api-verif-f09-commit", "fp-1");
  const validCommit = await revalidate("fp-1", "api-verif-f09-commit");
  assert.equal(validCommit.statusCode, 200, validCommit.body);
  const fp1Row = listSecurityAuditRemediations(h.db, "api-revalida-f09")
    .find((item) => item.fingerprint === "fp-1");
  assert.equal(fp1Row?.state, "verified_fixed");
  const commitEvidence = fp1Row?.evidence[0] as Record<string, unknown>;
  assert.equal(commitEvidence.fingerprint, "fp-1");
  assert.equal(commitEvidence.verificationAuditRunId, "api-verif-f09-commit");
  assert.deepEqual(commitEvidence.phase5Instances, ["phase5-api-verif-f09-commit-fp-1"]);
  assert.equal(commitEvidence.verificationSourceRef, "def456");
  assert.equal(commitEvidence.verificationSourceDirty, false);
  assert.deepEqual(commitEvidence.verificationScope, { kind: "project" });
  assert.equal(commitEvidence.findingPath, "src/handler.ts");
  assert.equal(commitEvidence.remediationExecutionRunId, executionRunIdFp1);

  // Caso válido con worktree dirty posterior a la remediación no commiteada.
  seedVerification("api-verif-f09-dirty", { sourceDirty: true });
  seedPhase5("api-verif-f09-dirty", "fp-3");
  const validDirty = await revalidate("fp-3", "api-verif-f09-dirty");
  assert.equal(validDirty.statusCode, 200, validDirty.body);
  const fp3Row = listSecurityAuditRemediations(h.db, "api-revalida-f09")
    .find((item) => item.fingerprint === "fp-3");
  assert.equal(fp3Row?.state, "verified_fixed");
  const dirtyEvidence = fp3Row?.evidence[0] as Record<string, unknown>;
  assert.equal(dirtyEvidence.verificationSourceRef, "abc123");
  assert.equal(dirtyEvidence.verificationSourceDirty, true);
  assert.equal(dirtyEvidence.findingPath, "src/model.ts");
  assert.deepEqual(dirtyEvidence.phase5Instances, ["phase5-api-verif-f09-dirty-fp-3"]);
});

test("N2: cancelling without an active audit execution returns 409 without mutating", async () => {
  const h = harness();
  seedRun(h.db, "api-cancel-inactiva");
  h.setExecution({
    run: { id: "api-cancel-inactiva", status: "succeeded" },
    agents: [], events: [], decisions: [], decisionHistory: [],
  });

  const response = await h.app.inject({
    method: "POST",
    url: "/api/security-audit/runs/api-cancel-inactiva/cancel",
    payload: {},
  });
  assert.equal(response.statusCode, 409);
  assert.match((response.json() as { error: string }).error, /no tiene una ejecución activa/);
  assert.equal(
    isSecurityAuditCancelRequested(h.db, "api-cancel-inactiva"),
    false,
    "sin mutar el estado del run",
  );
  assert.equal(h.calls.some((call) => call.type === "cancel"), false, "no se llama a cancelExecution");
});

test("N3: the remediation path must match the audit run path canonically", async () => {
  const h = harness();
  seedRun(h.db, "api-ruta-remedio");
  upsertSecurityAuditFinding(h.db, "api-ruta-remedio", {
    fingerprint: "fp-1",
    verdict: "confirmed",
    severity: "high",
    payload: { title: "Confirmado" },
  });

  const other = await h.app.inject({
    method: "POST",
    url: "/api/security-audit/runs/api-ruta-remedio/remediations",
    payload: { fingerprints: ["fp-1"], approved: true, preflightDepth: "focused", path: "/srv/otro" },
  });
  assert.equal(other.statusCode, 400);
  assert.match((other.json() as { error: string }).error, /coincidir/);
  assert.equal(h.calls.length, 0, "sin ejecución con ruta distinta");

  // Misma ruta canónica (con barra final) → aceptada.
  const same = await h.app.inject({
    method: "POST",
    url: "/api/security-audit/runs/api-ruta-remedio/remediations",
    payload: { fingerprints: ["fp-1"], approved: true, preflightDepth: "focused", path: "/srv/example/" },
  });
  assert.equal(same.statusCode, 202, same.body);
  assert.equal(h.calls.find((call) => call.type === "start")?.projectPath, "/srv/example");
});

test("N5: writerTeamCheck rejects when a planner-required agent is disabled", async () => {
  const h = harness();
  seedRun(h.db, "api-equipo-remedio");
  upsertSecurityAuditFinding(h.db, "api-equipo-remedio", {
    fingerprint: "fp-1",
    verdict: "confirmed",
    severity: "high",
    payload: { title: "Confirmado" },
  });
  // Implementer es requisito del plan real de remediación: se deshabilita.
  h.setAssignments([
    { agentId: "architect", engine: "opencode", modelId: "opencode-go/mimo-v2.6-flash", permissionMode: "automatic", permissionProfile: "read-only", enabled: true },
    { agentId: "reviewer", engine: "claude", modelId: "anthropic/claude-sonnet-4-5", permissionMode: "automatic", permissionProfile: "read-only", enabled: true },
    { agentId: "tester", engine: "claude", modelId: "anthropic/claude-sonnet-4-5", permissionMode: "automatic", permissionProfile: "read-only", enabled: true },
    { agentId: "build", engine: "claude", modelId: "anthropic/claude-sonnet-4-5", permissionMode: "automatic", permissionProfile: "read-only", enabled: true },
    { agentId: "cloud-arbiter", engine: "opencode", modelId: "opencode-go/mimo-v2.6-flash", permissionMode: "automatic", permissionProfile: "read-only", enabled: true },
    { agentId: "reverse", engine: "opencode", modelId: "opencode-go/mimo-v2.6-flash", permissionMode: "automatic", permissionProfile: "read-only", enabled: true },
  ]);

  const response = await h.app.inject({
    method: "POST",
    url: "/api/security-audit/runs/api-equipo-remedio/remediations",
    payload: { fingerprints: ["fp-1"], approved: true, preflightDepth: "focused" },
  });
  assert.equal(response.statusCode, 409);
  assert.match((response.json() as { error: string }).error, /implementer/);
  assert.equal(h.calls.filter((call) => call.type === "start").length, 0, "sin ejecución sin el equipo completo");
});

test("Paquete 8: POST answers preparing and the first poll answers 202 until the row exists", async () => {
  const h = harness();
  const base = {
    path: "/srv/example", profile: "quick", scope: { kind: "project" }, preflightDepth: "quick",
  };

  // (a) El POST mantiene el 202 y anuncia preparing.
  const started = await h.app.inject({ method: "POST", url: "/api/security-audit/runs", payload: base });
  assert.equal(started.statusCode, 202, started.body);
  const startedBody = started.json() as Record<string, unknown>;
  assert.equal(startedBody.preparing, true);
  const runId = String(startedBody.runId);

  // (b) GET inmediato: la fila de auditoría aún no existe (el orquestador la
  // crea de forma asíncrona) → 202 preparing, NUNCA 404.
  assert.equal(isSecurityAuditPreparing(runId), true);
  const preparing = await h.app.inject({ method: "GET", url: `/api/security-audit/runs/${runId}` });
  assert.equal(preparing.statusCode, 202, preparing.body);
  const preparingBody = preparing.json() as Record<string, unknown>;
  assert.equal(preparingBody.preparing, true);
  assert.equal(preparingBody.runId, runId);
  assert.equal(preparingBody.message, "La auditoría está en preparación.");

  // (d) Un identificador realmente desconocido sigue siendo 404.
  const unknown = await h.app.inject({ method: "GET", url: "/api/security-audit/runs/api-desconocido" });
  assert.equal(unknown.statusCode, 404);

  // (c) Cuando la fila ya existe en la BD → 200 normal y el id sale del registro.
  seedRun(h.db, runId);
  const ready = await h.app.inject({ method: "GET", url: `/api/security-audit/runs/${runId}` });
  assert.equal(ready.statusCode, 200, ready.body);
  const readyBody = ready.json() as { run: { runId: string } };
  assert.equal(readyBody.run.runId, runId);
  assert.equal(isSecurityAuditPreparing(runId), false, "el id sale del registro al existir la fila");
});

test("Paquete 8: an expired preparing entry no longer shields the identifier", async () => {
  const h = harness();
  const expired = "api-preparacion-caducada";
  markSecurityAuditPreparing(expired, Date.now() - (SECURITY_AUDIT_PREPARING_TTL_MS + 1_000));
  assert.equal(isSecurityAuditPreparing(expired), false, "la entrada caducó al superar el TTL");

  // (e) TTL expirado sin fila en la BD → 404 (el puente no es eterno).
  const response = await h.app.inject({ method: "GET", url: `/api/security-audit/runs/${expired}` });
  assert.equal(response.statusCode, 404);
  assert.match((response.json() as { error: string }).error, /no encontrada/);
});

test("Paquete 8: cancelling while preparing answers 202 without faking the cancellation", async () => {
  const h = harness();
  const base = {
    path: "/srv/example", profile: "quick", scope: { kind: "project" }, preflightDepth: "quick",
  };
  const started = await h.app.inject({ method: "POST", url: "/api/security-audit/runs", payload: base });
  assert.equal(started.statusCode, 202, started.body);
  const runId = String((started.json() as Record<string, unknown>).runId);

  // (f) El run aún no existe: se admite la petición (202) pero NO se finge una
  // cancelación efectiva ni se toca el motor de ejecuciones.
  const cancelled = await h.app.inject({
    method: "POST", url: `/api/security-audit/runs/${runId}/cancel`, payload: {},
  });
  assert.equal(cancelled.statusCode, 202, cancelled.body);
  const body = cancelled.json() as Record<string, unknown>;
  assert.equal(body.preparing, true);
  assert.equal(body.cancelRequested, true);
  assert.equal(body.cancelled, undefined, "sin cancelación efectiva inventada");
  assert.equal(h.calls.some((call) => call.type === "cancel"), false, "no hay ejecución que cancelar todavía");

  // La cancelación normal de un run existente no se rompe.
  seedRun(h.db, "api-cancel-existente");
  h.db.prepare(
    `INSERT INTO execution_runs (id, project_path, instructions, status, started_at, updated_at)
     VALUES (?, '/srv/example', 'Auditoría', 'running', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  ).run("api-cancel-existente");
  h.setExecution({
    run: { id: "api-cancel-existente", status: "running" },
    agents: [], events: [], decisions: [], decisionHistory: [],
  });
  const normal = await h.app.inject({
    method: "POST", url: "/api/security-audit/runs/api-cancel-existente/cancel", payload: {},
  });
  assert.equal(normal.statusCode, 200, normal.body);
  assert.equal((normal.json() as Record<string, unknown>).cancelled, true);
});

test("Paquete 8b: cancel during preparation with a live execution cancels it for real", async () => {
  const h = harness();
  const base = {
    path: "/srv/example", profile: "quick", scope: { kind: "project" }, preflightDepth: "quick",
  };
  const started = await h.app.inject({ method: "POST", url: "/api/security-audit/runs", payload: base });
  assert.equal(started.statusCode, 202, started.body);
  const runId = String((started.json() as Record<string, unknown>).runId);

  // (a) La ejecución ya existe en el proceso (startExecution la creó): la
  // cancelación es REAL por la misma vía que la normal.
  h.setExecution({
    run: { id: runId, status: "running" },
    agents: [], events: [], decisions: [], decisionHistory: [],
  });
  const cancelled = await h.app.inject({
    method: "POST", url: `/api/security-audit/runs/${runId}/cancel`, payload: {},
  });
  assert.equal(cancelled.statusCode, 202, cancelled.body);
  const body = cancelled.json() as Record<string, unknown>;
  assert.equal(body.cancelled, true, "cancelación real de la ejecución");
  assert.equal(body.executionRunId, runId);
  assert.equal(body.pendingCancelApplied, false);
  assert.equal(h.calls.filter((call) => call.type === "cancel").length, 1);
  // La fila aún no existe: la persistencia del flag queda pendiente.
  assert.equal(isSecurityAuditCancelRequested(h.db, runId), false);
  assert.equal(isSecurityAuditPendingCancel(runId), true);

  // (c) Al aparecer la fila, el GET aplica la cancelación pendiente SIN
  // volver a cancelar la ejecución (sin doble cancelación).
  seedRun(h.db, runId);
  const ready = await h.app.inject({ method: "GET", url: `/api/security-audit/runs/${runId}` });
  assert.equal(ready.statusCode, 200, ready.body);
  assert.equal(
    (ready.json() as { run: { cancelRequested: boolean } }).run.cancelRequested,
    true,
    "cancelRequested del run persistido al existir la fila",
  );
  assert.equal(h.calls.filter((call) => call.type === "cancel").length, 1, "sin doble cancelación");
  assert.equal(isSecurityAuditPendingCancel(runId), false, "entrada consumida una sola vez");
});

test("Paquete 8b: cancel without an execution stays pending and is applied once the row exists", async () => {
  const h = harness();
  const base = {
    path: "/srv/example", profile: "quick", scope: { kind: "project" }, preflightDepth: "quick",
  };
  const started = await h.app.inject({ method: "POST", url: "/api/security-audit/runs", payload: base });
  assert.equal(started.statusCode, 202, started.body);
  const runId = String((started.json() as Record<string, unknown>).runId);
  // Sin setExecution: todavía no hay ejecución consultable.

  // (b) Sin ejecución: queda pendiente, sin cancelación fingida.
  const cancelled = await h.app.inject({
    method: "POST", url: `/api/security-audit/runs/${runId}/cancel`, payload: {},
  });
  assert.equal(cancelled.statusCode, 202, cancelled.body);
  const body = cancelled.json() as Record<string, unknown>;
  assert.equal(body.preparing, true);
  assert.equal(body.cancelRequested, true);
  assert.equal(body.pendingCancelApplied, false);
  assert.equal(body.cancelled, undefined, "sin cancelación efectiva inventada");
  assert.equal(h.calls.some((call) => call.type === "cancel"), false);
  assert.equal(isSecurityAuditPendingCancel(runId), true);

  // Mientras la fila no exista, el sondeo sigue 202 y la entrada NO se consume.
  const preparing = await h.app.inject({ method: "GET", url: `/api/security-audit/runs/${runId}` });
  assert.equal(preparing.statusCode, 202, preparing.body);
  assert.equal(isSecurityAuditPendingCancel(runId), true, "la pendiente sobrevive al sondeo");

  // Aparece la fila → el GET aplica la pendiente (cancelRequested real).
  seedRun(h.db, runId);
  const ready = await h.app.inject({ method: "GET", url: `/api/security-audit/runs/${runId}` });
  assert.equal(ready.statusCode, 200, ready.body);
  assert.equal((ready.json() as { run: { cancelRequested: boolean } }).run.cancelRequested, true);
  assert.equal(isSecurityAuditCancelRequested(h.db, runId), true);
  assert.equal(isSecurityAuditPendingCancel(runId), false, "entrada consumida al aplicar");
  assert.equal(h.calls.some((call) => call.type === "cancel"), false, "no hay ejecución que cancelar");
});

test("Paquete 8b: an expired pending cancel is never applied", async () => {
  const h = harness();
  const expired = "api-cancel-pendiente-caducada";
  markSecurityAuditPendingCancel(expired, Date.now() - (SECURITY_AUDIT_PENDING_CANCEL_TTL_MS + 1_000));
  assert.equal(isSecurityAuditPendingCancel(expired), false, "la entrada caducó al superar el TTL");

  // (d) TTL expirado: aunque la fila exista, no se aplica nada.
  seedRun(h.db, expired);
  const ready = await h.app.inject({ method: "GET", url: `/api/security-audit/runs/${expired}` });
  assert.equal(ready.statusCode, 200, ready.body);
  assert.equal(
    (ready.json() as { run: { cancelRequested: boolean } }).run.cancelRequested,
    false,
    "una entrada caducada no aplica ninguna cancelación",
  );
  assert.equal(isSecurityAuditCancelRequested(h.db, expired), false);
});

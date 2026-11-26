/**
 * Rutas HTTP de la modalidad `security-audit` del Control Center.
 *
 * Principios:
 * - `POST /api/security-audit/intent` clasifica sin efectos: guidance nunca
 *   crea directorios, archivos ni runs de auditoría.
 * - `POST /api/security-audit/runs` es la ÚNICA puerta de entrada de una
 *   auditoría completa y replica las validaciones de `/api/executions`
 *   (ruta absoluta/canónica, preconsulta + decisión + equipo guardado,
 *   favoritos, equipo habilitado, alcance del Auditor).
 * - El historial y el estado salen de la persistencia real (nada de fixtures).
 * - La remediación es una ejecución TRADICIONAL independiente; la auditoría
 *   jamás modifica el target y una ejecución exitosa no equivale a
 *   `verified_fixed` (solo la revalidación con evidencia).
 */

import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import {
  type AgentAssignment,
  type ClaudeProviderId,
  type ExecutionSnapshot,
  type FavoriteModel,
  type ProjectPreflightSnapshot,
} from "./database.js";
import type { ResearchDepth } from "./task-planner.js";
import { planTask } from "./task-planner.js";
import type { StartExecutionOptions } from "./execution.js";
import { detectSecurityAuditIntent } from "./security-audit-intent.js";
import { planForSecurityAuditIntent } from "./security-audit-contracts.js";
import {
  sortSecurityAuditIncompleteReasons,
  validateSecurityAuditTeam,
  type SecurityAuditRosterEntry,
} from "./security-audit-orchestrator.js";
import { auditInvocationUsage } from "./security-audit-usage.js";
import { computeSecurityAuditPhaseStates } from "./security-audit-phase-status.js";
import { validateSecurityAuditStartOptions } from "./security-audit-start.js";
import {
  createSecurityAuditRemediation,
  getSecurityAuditRun,
  // Paquete 2: historial de consolidaciones expuesto en el estado del run.
  loadSecurityAuditWorkState,
  listSecurityAuditFindings,
  listSecurityAuditInvocations,
  listSecurityAuditRemediations,
  listSecurityAuditRuns,
  listSecurityAuditUnits,
  requestSecurityAuditCancel,
  setSecurityAuditValidators,
  transitionSecurityAuditRemediation,
  type SecurityAuditRunRow,
} from "./security-audit-persistence.js";
import {
  readSecurityAuditArtifact,
  readSecurityAuditSourceSnapshot,
  resolveSecurityAuditRunDirectory,
} from "./security-audit-artifacts.js";
import { validateCoverageLedgerFile, validateFindingsFile } from "./security-audit-upstream.js";

export interface SecurityAuditApiDeps {
  factoryRoot: string;
  startExecution: (
    projectPath: string,
    instructions: string,
    factoryRoot: string,
    depth?: ResearchDepth,
    options?: StartExecutionOptions,
  ) => Promise<{ runId: string }>;
  cancelExecution: (runId: string) => Promise<void>;
  analyzeProject: (path: string, depth: ResearchDepth) => Promise<{ path: string }>;
  getProjectPreflight: (path: string, depth: string) => ProjectPreflightSnapshot | null;
  consumeProjectPreflight: (path: string, depth: string) => { consumed: boolean; reason?: string };
  listAssignments: () => AgentAssignment[];
  listFavoriteModels: () => FavoriteModel[];
  getClaudeProviderPreference: () => ClaudeProviderId;
  getExecution: (runId: string) => ExecutionSnapshot | null;
  getFactoryDatabase: () => DatabaseSync;
  /** Ejecuciones tradicionales vinculadas a un run de auditoría (origen o reanudación). */
  listSecurityAuditExecutionRunIds: (auditRunId: string) => string[];
  validateCapabilityScopeInput: (projectPath: string, input: unknown) => { declarations: string };
  workInstructionLimitError?: (text: string) => string | null;
}

export const SECURITY_AUDIT_REPORT_ARTIFACTS = [
  "run-metadata.json",
  "architecture.md",
  "coverage-ledger.json",
  "findings.json",
  "REPORT.md",
  "FINDINGS-DETAIL.md",
  "NEEDS-VALIDATION.md",
] as const;
export type SecurityAuditReportArtifact = (typeof SECURITY_AUDIT_REPORT_ARTIFACTS)[number];

const ARTIFACT_CONTENT_TYPES: Record<SecurityAuditReportArtifact, string> = {
  "run-metadata.json": "application/json; charset=utf-8",
  "coverage-ledger.json": "application/json; charset=utf-8",
  "findings.json": "application/json; charset=utf-8",
  "architecture.md": "text/markdown; charset=utf-8",
  "REPORT.md": "text/markdown; charset=utf-8",
  "FINDINGS-DETAIL.md": "text/markdown; charset=utf-8",
  "NEEDS-VALIDATION.md": "text/markdown; charset=utf-8",
};

const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ARTIFACT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FINGERPRINT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
const DEPTH_VALUES: readonly string[] = ["quick", "focused", "deep"];
const PROFILE_VALUES: readonly string[] = ["quick", "standard", "deep"];

/** Paquete 7: mismo límite que la clasificación de intención (8000). */
export const SECURITY_AUDIT_INSTRUCTIONS_MAX_CHARS = 8000;
/** Paquete 7: texto por defecto cuando el operador no escribe instrucción. */
export const SECURITY_AUDIT_DEFAULT_INSTRUCTIONS =
  "Auditoría de seguridad completa solicitada desde Security Operations.";

/**
 * Paquete 8: registro en memoria acotado de runs cuya FILA de auditoría aún no
 * existe en la BD (el `202` de `POST /runs` puede preceder a la inserción que
 * hace el orquestador de forma asíncrona). Es SOLO un puente anti-404 prematuro:
 * la BD sigue siendo la única fuente de verdad y las entradas caducan (TTL) o
 * se acotan (máximo de entradas), así que nunca se inventa un run.
 */
export const SECURITY_AUDIT_PREPARING_TTL_MS = 60_000;
const SECURITY_AUDIT_PREPARING_MAX_ENTRIES = 64;
const preparingAuditRuns = new Map<string, { startedAt: number }>();

function pruneSecurityAuditPreparing(now: number): void {
  for (const [runId, entry] of preparingAuditRuns) {
    if (now - entry.startedAt > SECURITY_AUDIT_PREPARING_TTL_MS) {
      preparingAuditRuns.delete(runId);
    }
  }
}

/** Marca un runId como "en preparación" (id conocido y fila aún no creada). */
export function markSecurityAuditPreparing(runId: string, startedAt: number = Date.now()): void {
  pruneSecurityAuditPreparing(startedAt);
  if (!preparingAuditRuns.has(runId) && preparingAuditRuns.size >= SECURITY_AUDIT_PREPARING_MAX_ENTRIES) {
    // Map conserva el orden de inserción: se expulsa la entrada más antigua.
    const oldest = preparingAuditRuns.keys().next();
    if (!oldest.done) preparingAuditRuns.delete(oldest.value);
  }
  preparingAuditRuns.set(runId, { startedAt });
}

/** true si el runId sigue en preparación (la entrada no ha caducado). */
export function isSecurityAuditPreparing(runId: string, now: number = Date.now()): boolean {
  pruneSecurityAuditPreparing(now);
  return preparingAuditRuns.has(runId);
}

/** El run ya existe en la BD (o dejó de interesar): sale del registro. */
export function clearSecurityAuditPreparing(runId: string): void {
  preparingAuditRuns.delete(runId);
}

/**
 * Paquete 8b: registro acotado (conjunto con política TTL 60 s y máx. 64) de
 * cancelaciones solicitadas mientras el run estaba EN PREPARACIÓN y todavía no
 * había nada que cancelar. Garantiza que la intención del operador se aplique
 * DE VERDAD en cuanto la fila del run exista (y solo entonces): sin esto, el
 * run aparecería `in_progress` con `cancelRequested:false` y consumiría
 * agentes y presupuesto pese a la cancelación.
 */
export const SECURITY_AUDIT_PENDING_CANCEL_TTL_MS = 60_000;
const SECURITY_AUDIT_PENDING_CANCEL_MAX_ENTRIES = 64;
const pendingAuditCancels = new Map<string, { requestedAt: number }>();

function prunePendingAuditCancels(now: number): void {
  for (const [runId, entry] of pendingAuditCancels) {
    if (now - entry.requestedAt > SECURITY_AUDIT_PENDING_CANCEL_TTL_MS) {
      pendingAuditCancels.delete(runId);
    }
  }
}

/** Registra una cancelación pendiente para un run en preparación. */
export function markSecurityAuditPendingCancel(runId: string, requestedAt: number = Date.now()): void {
  prunePendingAuditCancels(requestedAt);
  if (!pendingAuditCancels.has(runId) && pendingAuditCancels.size >= SECURITY_AUDIT_PENDING_CANCEL_MAX_ENTRIES) {
    const oldest = pendingAuditCancels.keys().next();
    if (!oldest.done) pendingAuditCancels.delete(oldest.value);
  }
  pendingAuditCancels.set(runId, { requestedAt });
}

/** true si hay una cancelación pendiente VIGENTE para el runId. */
export function isSecurityAuditPendingCancel(runId: string, now: number = Date.now()): boolean {
  prunePendingAuditCancels(now);
  return pendingAuditCancels.has(runId);
}

/** Consume la entrada (una sola vez; las caducadas ya no cuentan). */
export function takeSecurityAuditPendingCancel(runId: string): boolean {
  prunePendingAuditCancels(Date.now());
  return pendingAuditCancels.delete(runId);
}

/**
 * Paquete 7: instrucción efectiva de un run de auditoría. FUENTE: el campo
 * `instructions` del execution run de ORIGEN (el primero vinculado al run de
 * auditoría, que conserva el texto original incluso tras reanudaciones).
 * Devuelve cadena vacía si no hay ejecución asociada o sin texto: nunca se
 * inventa una instrucción.
 */
function effectiveInstructionsForRun(
  deps: SecurityAuditApiDeps,
  runId: string,
): string {
  for (const executionId of deps.listSecurityAuditExecutionRunIds(runId)) {
    const execution = deps.getExecution(executionId);
    const text = execution?.run?.instructions;
    if (typeof text === "string" && text.trim()) return text.trim();
    break;
  }
  return "";
}

type FailResult = { ok: false; status: number; error: string };
type HandlerResult =
  | { ok: true; status: number; payload: Record<string, unknown> }
  | FailResult;

function fail(status: number, error: string): FailResult {
  return { ok: false, status, error };
}

function ok(status: number, payload: Record<string, unknown>): HandlerResult {
  return { ok: true, status, payload };
}

function bodyOf(body: unknown): Record<string, unknown> {
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
}

function nonFavoriteAssignment(deps: SecurityAuditApiDeps): AgentAssignment | undefined {
  const provider = deps.getClaudeProviderPreference();
  const favoriteKeys = new Set(
    deps.listFavoriteModels()
      .filter((favorite) => favorite.provider === (favorite.engine === "claude" ? provider : "opencode"))
      .map((favorite) => `${favorite.engine}|${favorite.modelId}`),
  );
  return deps.listAssignments()
    .filter((item) => item.enabled)
    .find((item) => !favoriteKeys.has(`${item.engine}|${item.modelId}`));
}

/** Roster de auditoría: agentes habilitados con identidad oficial. */
function buildAuditRoster(deps: SecurityAuditApiDeps): SecurityAuditRosterEntry[] {
  const known = new Set([
    "architect", "build", "implementer", "reviewer", "tester", "reverse", "cloud-arbiter",
  ]);
  return deps.listAssignments()
    .filter((item) => item.enabled && known.has(item.agentId))
    .map((item) => ({
      agentId: item.agentId as SecurityAuditRosterEntry["agentId"],
      engine: item.engine,
      modelId: item.modelId,
    }));
}

function admissionChecks(
  deps: SecurityAuditApiDeps,
  input: { projectPath: string; preflightDepth: unknown; allowConsumed?: boolean },
): FailResult | null {
  if (!input.projectPath || !isAbsolute(input.projectPath)) {
    return fail(400, "Selecciona una ruta absoluta para el proyecto.");
  }
  if (!DEPTH_VALUES.includes(String(input.preflightDepth))) {
    return fail(400, "La profundidad de la preconsulta no coincide con la registrada.");
  }
  const nonFavorite = nonFavoriteAssignment(deps);
  if (nonFavorite) {
    return fail(409,
      `No se puede iniciar: el agente ${nonFavorite.agentId} tiene asignado ${nonFavorite.modelId}, ` +
      "que no está marcado como favorito.");
  }
  const preflight = deps.getProjectPreflight(input.projectPath, String(input.preflightDepth));
  if (!preflight) {
    return fail(409, "La ruta o profundidad no coinciden con una preconsulta vigente. Ejecuta primero la preconsulta del proyecto.");
  }
  if (!preflight.decision) {
    return fail(409, "Primero acepta la propuesta automática o registra la configuración manual.");
  }
  if (!preflight.teamSaved) {
    return fail(409, "Guarda el equipo de agentes después de aceptar la propuesta o elegir la configuración manual.");
  }
  if (preflight.consumed && input.allowConsumed !== true) {
    return fail(409, "Esta preconsulta ya fue utilizada. Ejecuta una nueva preconsulta para iniciar otra auditoría inicial.");
  }
  return null;
}

async function consumeAdmission(
  deps: SecurityAuditApiDeps,
  input: { projectPath: string; preflightDepth: string; consume?: boolean },
): Promise<FailResult | null> {
  try {
    const revalidated = await deps.analyzeProject(input.projectPath, input.preflightDepth as ResearchDepth);
    if (revalidated.path !== input.projectPath) {
      return fail(409, "La ruta real del proyecto cambió desde la preconsulta. Ejecuta nuevamente la preconsulta y confirma la ruta canónica.");
    }
  } catch (error) {
    return fail(409, error instanceof Error ? error.message : String(error));
  }
  // La remediación ya consumió la preconsulta al auditar: `approved: true` es
  // la nueva autorización explícita y no se exige otra preconsulta imposible.
  if (input.consume === false) return null;
  const consumed = deps.consumeProjectPreflight(input.projectPath, input.preflightDepth);
  if (!consumed.consumed) {
    return fail(409, consumed.reason ?? "Completa el flujo de preconsulta antes de iniciar.");
  }
  return null;
}

function teamCheck(deps: SecurityAuditApiDeps, profile: string): FailResult | null {
  if (!PROFILE_VALUES.includes(profile)) {
    return fail(400, "El perfil debe ser quick, standard o deep.");
  }
  const team = validateSecurityAuditTeam(buildAuditRoster(deps), profile as "quick" | "standard" | "deep");
  if (!team.ok) {
    return fail(409,
      "El equipo habilitado no cubre los roles de la auditoría: " + team.missing.join(", ") +
      ". Habilita y guarda el equipo antes de iniciar.");
  }
  return null;
}

/**
 * Coherencia con el plan REAL de remediación: se clasifican las instrucciones
 * con el planificador (ruta securityRemediation) y se exige que todas las
 * especialistas recomendadas estén habilitadas, incluido Architect.
 */
function writerTeamCheck(deps: SecurityAuditApiDeps, instructions: string): FailResult | null {
  const plan = planTask(instructions, undefined, { securityRemediation: true });
  if (!plan.changesExpected) {
    return fail(409, "El plan de remediación no quedó como implementación; revisa las instrucciones.");
  }
  const enabled = new Set(deps.listAssignments().filter((item) => item.enabled).map((item) => item.agentId));
  const missing = plan.recommendedAgents.filter((agentId) => !enabled.has(agentId));
  if (missing.length > 0) {
    return fail(409,
      "El plan de remediación necesita estos especialistas habilitados: " + missing.join(", ") +
      ". Habilita y guarda el equipo antes de continuar.");
  }
  return null;
}

function parseRunId(value: unknown): string | null {
  return typeof value === "string" && RUN_ID_PATTERN.test(value) ? value : null;
}

/**
 * Paquete 8b: ejecución ACTIVA real de un run con la misma regla en la
 * cancelación normal y en la cancelación durante la preparación.
 */
function activeAuditExecution(
  deps: SecurityAuditApiDeps,
  runId: string,
): ExecutionSnapshot | null {
  const executionIds = deps.listSecurityAuditExecutionRunIds(runId);
  const activeId = executionIds.length > 0 ? executionIds[executionIds.length - 1] : null;
  const execution = activeId ? deps.getExecution(activeId) : null;
  if (!execution || !["queued", "running", "waiting"].includes(execution.run.status)) return null;
  return execution;
}

/**
 * Paquete 8b: vía ÚNICA de cancelación real (reutilizada por la cancelación
 * normal y por la cancelación durante la preparación). El flag persistido es
 * un UPDATE idempotente: si la fila aún no existe no muta nada y la
 * persistencia queda a cargo de la cancelación pendiente.
 */
async function cancelAuditViaExecution(
  deps: SecurityAuditApiDeps,
  db: DatabaseSync,
  runId: string,
  execution: ExecutionSnapshot,
): Promise<{ cancelled: true; runId: string; executionRunId: string }> {
  requestSecurityAuditCancel(db, runId);
  await deps.cancelExecution(execution.run.id);
  return { cancelled: true, runId, executionRunId: execution.run.id };
}

/**
 * Paquete 8b: aplica una cancelación pendiente en cuanto la fila del run
 * exista (solo entonces). Consume la entrada UNA vez, no hace nada si la
 * entrada caducó o la fila sigue ausente, y persiste el flag real
 * (`cancel_requested`) que el orquestador consulta en sus compuertas.
 */
function applySecurityAuditPendingCancel(deps: SecurityAuditApiDeps, runId: string): boolean {
  if (!isSecurityAuditPendingCancel(runId)) return false;
  const db = deps.getFactoryDatabase();
  if (!getSecurityAuditRun(db, runId)) return false;
  takeSecurityAuditPendingCancel(runId);
  requestSecurityAuditCancel(db, runId);
  return true;
}

function mapRunSummary(row: SecurityAuditRunRow): Record<string, unknown> {
  return {
    runId: row.runId,
    projectPath: row.projectPath,
    profile: row.profile,
    intent: row.intent,
    runStatus: row.runStatus,
    incompleteReason: row.incompleteReason,
    phases: row.phases,
    completedPhases: row.phases.filter((state) => state === "complete").length,
    executionPolicy: row.executionPolicy,
    sandboxStatus: row.sandboxStatus,
    cancelRequested: row.cancelRequested,
    ledgerValidator: row.ledgerValidator,
    findingsValidator: row.findingsValidator,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    finishedAt: row.finishedAt,
  };
}

function buildStatusPayload(deps: SecurityAuditApiDeps, runId: string): HandlerResult | null {
  const db = deps.getFactoryDatabase();
  const run = getSecurityAuditRun(db, runId);
  if (!run) return fail(404, "Auditoría no encontrada.");

  const executionIds = deps.listSecurityAuditExecutionRunIds(runId);
  const activeExecutionId = executionIds.length > 0 ? executionIds[executionIds.length - 1] : null;
  const execution = activeExecutionId ? deps.getExecution(activeExecutionId) : null;

  const units = listSecurityAuditUnits(db, runId);
  const findings = listSecurityAuditFindings(db, runId);
  const invocations = listSecurityAuditInvocations(db, runId);
  const usageByInvocation = auditInvocationUsage(db, invocations);
  const remediations = listSecurityAuditRemediations(db, runId);
  // Paquete 2: consolidaciones de candidatos duplicados aplicadas por el
  // orquestador (historial persistido). `loadSecurityAuditWorkState` ya valida
  // el JSON campo a campo; sin estado o corrupto → lista vacía (null honesto).
  const workState = loadSecurityAuditWorkState(db, runId);
  const consolidations = workState?.consolidations ?? [];

  const unitsByStatus: Record<string, number> = {};
  for (const unit of units) unitsByStatus[unit.status] = (unitsByStatus[unit.status] ?? 0) + 1;
  const pendingUnits = units
    .filter((unit) => unit.status === "planned" || unit.status === "candidate" || unit.status === "blocked" || unit.status === "in_progress")
    .map((unit) => unit.unitId);
  const deferredUnits = units.filter((unit) => unit.status === "deferred").map((unit) => unit.unitId);
  // Defecto 3: separar cobertura pendiente de caza (`planned`/`in_progress`/
  // `blocked`) de candidatos pendientes de validación (`candidate`); la forma
  // pública de `coverage.pendingUnits` NO cambia.
  const pendingCoverageUnits = units
    .filter((unit) => unit.status === "planned" || unit.status === "in_progress" || unit.status === "blocked")
    .length;
  const pendingCandidateUnits = units.filter((unit) => unit.status === "candidate").length;

  const confirmed = findings.filter((finding) => finding.verdict === "confirmed");
  const bySeverity: Record<string, number> = {};
  for (const finding of confirmed) {
    const key = finding.severity ?? "sin_clasificar";
    bySeverity[key] = (bySeverity[key] ?? 0) + 1;
  }

  const blockers: string[] = [];
  if (run.incompleteReason) {
    blockers.push(`Estado incompleto: ${run.incompleteReason}.`);
  }
  if (run.cancelRequested) blockers.push("Cancelación solicitada por el operador.");
  if (run.ledgerValidator === "fail") {
    blockers.push("El validador oficial de coverage-ledger falló; vuelve a validar antes de completar.");
  }
  if (run.findingsValidator === "fail") {
    blockers.push("El validador oficial de findings falló; vuelve a validar antes de completar.");
  }
  if (pendingUnits.length > 0) {
    blockers.push(`${pendingUnits.length} unidad(es) de cobertura pendientes.`);
  }
  if (deferredUnits.length > 0) {
    blockers.push(`${deferredUnits.length} unidad(es) diferidas por presupuesto o cobertura.`);
  }
  if (run.sandboxBlockers.length > 0) {
    blockers.push("Bloqueos de sandbox: " + run.sandboxBlockers.join(", ") + ".");
  }
  if (execution && ["failed", "interrupted"].includes(execution.run.status)) {
    blockers.push("La ejecución asociada terminó con errores; consulta los eventos de la ejecución.");
  }

  const spent = run.budgetSpent as Record<string, number>;
  const reserved = run.budgetReserved as Record<string, number>;
  const config = run.budgetConfig as Record<string, unknown>;
  const spentTotal = ["recon", "hunters", "critics", "verifiers"]
    .reduce((total, key) => total + (typeof spent[key] === "number" ? spent[key] as number : 0), 0);

  // Paquete 6: lista completa de motivos oficiales del run (no solo el
  // primario). Defecto 4: el primario (`run.incompleteReason`, fijado también
  // de forma explícita en el cierre) SIEMPRE está presente y primero, aunque
  // el work_state tenga motivos que no lo incluyan; el resto se ordena con la
  // precedencia oficial. Un run `complete` no lleva motivos.
  const incompleteReasons = run.runStatus === "complete"
    ? []
    : run.incompleteReason
      ? [
          run.incompleteReason,
          ...sortSecurityAuditIncompleteReasons(
            (workState?.pendingReasons ?? []).filter((reason) => reason !== run.incompleteReason),
          ),
        ]
      : sortSecurityAuditIncompleteReasons(workState?.pendingReasons ?? []);
  // Paquete 6: desglose honesto por fase (recorrer las fases no equivale a
  // completarlas). `run.phases`/`progress` se conservan intactos.
  const phaseStates = computeSecurityAuditPhaseStates({
    profile: run.profile,
    phasesComplete: run.phases
      .map((state, index) => (state === "complete" ? index + 1 : null))
      .filter((phase): phase is number => phase !== null),
    unvalidatedCandidates: workState?.unvalidated ?? [],
    pendingUnits,
    pendingCoverageUnits,
    pendingCandidateUnits,
    incompleteReasons,
    consolidatedUnits: Object.keys(workState?.consolidatedUnitIds ?? {}).length,
  });

  return ok(200, {
    run: mapRunSummary(run),
    // Paquete 7: instrucción efectiva del operador. FUENTE: el execution run
    // de ORIGEN vinculado al run de auditoría (`execution_runs.instructions`);
    // cadena vacía si no hay ejecución asociada (nunca texto inventado).
    instructions: effectiveInstructionsForRun(deps, runId),
    incompleteReasons,
    scope: run.scope,
    budget: {
      maxInvocations: config.maxInvocations ?? null,
      maxConcurrency: config.maxConcurrency ?? run.maxConcurrency,
      maxDurationMs: config.maxDurationMs ?? run.maxDurationMs,
      spent: run.budgetSpent,
      reserved: run.budgetReserved,
      spentTotal,
    },
    progress: {
      completedPhases: run.phases.filter((state) => state === "complete").length,
      phases: run.phases.map((state, index) => ({ phase: index + 1, state })),
    },
    // Paquete 6: estado real por fase (completed/partial/blocked/not_applicable/
    // pending) con el motivo de cada matiz; no sustituye a `run.phases`.
    phaseStates,
    execution: execution
      ? {
          runId: execution.run.id,
          status: execution.run.status,
          agents: execution.agents.map((agent) => ({
            agentId: agent.agentId,
            engine: agent.engine,
            modelId: agent.modelId,
            sessionId: agent.sessionId,
            status: agent.status,
            permissionProfile: agent.permissionProfile,
            startedAt: agent.startedAt,
            finishedAt: agent.finishedAt,
          })),
        }
      : null,
    invocations: invocations.map((invocation) => ({
      instanceId: invocation.instanceId,
      usage: usageByInvocation.get(invocation.instanceId) ?? null,
      phase: invocation.phase,
      role: invocation.role,
      agentId: invocation.agentId,
      engine: invocation.engine,
      model: invocation.model,
      sessionId: invocation.sessionId,
      agentRunId: invocation.agentRunId,
      handoffId: invocation.handoffId,
      discovererInstanceId: invocation.discovererInstanceId,
      verificationKind: invocation.verificationKind,
      fingerprint: invocation.fingerprint,
      outcome: invocation.outcome,
      providerErrorKind: invocation.providerErrorKind,
      providerStatus: invocation.providerStatus,
      autoReplay: invocation.autoReplay,
      // F06: veredicto REAL de verificación cruzada + intención de plan y
      // evidencia estructurada (instancias, sesiones, huella y razón).
      crossEngineVerified: invocation.crossEngineVerified,
      crossEnginePlanned: invocation.crossEnginePlanned,
      crossEngineEvidence: invocation.crossEngineEvidence,
      startedAt: invocation.startedAt,
      finishedAt: invocation.finishedAt,
    })),
    coverage: {
      unitsTotal: units.length,
      byStatus: unitsByStatus,
      pendingUnits,
      deferredUnits,
    },
    findings: {
      total: findings.length,
      confirmed: confirmed.length,
      needsValidation: findings.filter((finding) => finding.verdict === "needs_validation").length,
      rejected: findings.filter((finding) => finding.verdict === "rejected").length,
      confirmedBySeverity: bySeverity,
      items: findings.map((finding) => ({
        fingerprint: finding.fingerprint,
        verdict: finding.verdict,
        severity: finding.severity,
        title: isRecordLike(finding.payload) ? String((finding.payload as Record<string, unknown>).title ?? "") : "",
      })),
    },
    remediations: remediations.map((remediation) => ({
      fingerprint: remediation.fingerprint,
      state: remediation.state,
      executionRunId: remediation.executionRunId,
      evidenceCount: remediation.evidence.length,
      updatedAt: remediation.updatedAt,
      completedAt: remediation.completedAt,
    })),
    validators: { ledger: run.ledgerValidator, findings: run.findingsValidator },
    // Paquete 2: historial de consolidación de candidatos duplicados (canónica,
    // aliases con sus unitIds y razón, e identidad que justificó la fusión).
    consolidations: consolidations.map((cluster) => ({
      canonicalFingerprint: cluster.canonicalFingerprint,
      canonicalUnitId: cluster.canonicalUnitId,
      aliases: cluster.aliases,
      rationale: cluster.rationale,
      key: cluster.key,
    })),
    blockers,
    cancelRequested: run.cancelRequested,
    sandbox: { status: run.sandboxStatus, blockers: run.sandboxBlockers },
  });
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * F09: identidad REAL de una invocación persistida: sesión, handoff y agentRun
 * no nulos. Sin ellos la instancia no es atribuible a una ejecución concreta.
 */
function isRealIdentifier(value: string | null): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * F09: extrae la ruta del fichero desde la ubicación (`location`) del registro
 * original (formato oficial `ruta:linea`). Devuelve null cuando no hay una
 * ruta verificable.
 */
function findingLocationPath(payload: unknown): string | null {
  if (!isRecordLike(payload)) return null;
  const trace = Array.isArray(payload.trace) ? payload.trace : [];
  const sink = [...trace].reverse().find((entry) => isRecordLike(entry) && entry.kind === "sink" && typeof entry.file === "string");
  const first = trace.find((entry) => isRecordLike(entry) && typeof entry.file === "string");
  const evidence = Array.isArray(payload.evidence) ? payload.evidence.find((entry) => isRecordLike(entry) && typeof entry.file === "string") : null;
  for (const entry of [sink, first, evidence]) {
    if (isRecordLike(entry) && typeof entry.file === "string" && entry.file.length > 0) return entry.file;
  }
  const location = payload.location;
  if (typeof location !== "string") return null;
  const rawPath = location.replace(/:\d+(?::\d+)?$/, "").trim();
  return rawPath.length > 0 ? rawPath : null;
}

/**
 * F09: ruta relativa POSIX del fichero del hallazgo respecto al proyecto de la
 * auditoría. Una ruta absoluta fuera del proyecto o con segmentos de
 * traversal no es verificable y devuelve null.
 */
function findingRelativePath(projectPath: string, rawPath: string): string | null {
  if (isAbsolute(rawPath)) {
    const root = resolve(projectPath);
    const resolved = resolve(rawPath);
    if (resolved !== root && !resolved.startsWith(root + sep)) return null;
    const relativePath = relative(root, resolved).split(sep).join("/");
    return relativePath.length > 0 ? relativePath : null;
  }
  const segments = rawPath.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return null;
  }
  return rawPath;
}

/**
 * F09: el alcance REAL persistido del run de verificación cubre la ruta del
 * hallazgo original. `project` cubre todo el proyecto; los demás alcances
 * exigen que la ruta esté incluida en los `scope_paths` reales persistidos
 * (ruta exacta cuando el scope_path es un fichero, prefijo cuando es un
 * directorio).
 */
function scopeCoversPath(scope: unknown, relativePath: string): boolean {
  if (!isRecordLike(scope) || typeof scope.kind !== "string") return false;
  if (scope.kind === "project") return true;
  const scopePaths = Array.isArray(scope.scopePaths)
    ? scope.scopePaths.filter((item): item is string => typeof item === "string")
    : [];
  return scopePaths.some((scopePath) =>
    relativePath === scopePath || relativePath.startsWith(`${scopePath}/`));
}

export function registerSecurityAuditRoutes(
  app: FastifyInstance,
  deps: SecurityAuditApiDeps,
): void {
  // 1) Intención: clasificación pura, sin archivos ni runs.
  app.post<{ Body: { text?: unknown } }>("/api/security-audit/intent", async (request, reply) => {
    const text = typeof request.body?.text === "string" ? request.body.text : "";
    if (!text.trim()) return reply.code(400).send({ error: "Escribe el texto a clasificar." });
    if (text.length > 8000) {
      return reply.code(400).send({ error: "El texto supera el límite de 8000 caracteres." });
    }
    const detection = detectSecurityAuditIntent(text);
    const plan = planForSecurityAuditIntent(detection.intent);
    return {
      intent: detection.intent,
      requiresClarification: detection.requiresClarification,
      matchedSignals: detection.matchedSignals,
      createsArtifacts: plan.createsArtifacts,
      sixPhasePlan: plan.sixPhasePlan,
      phases: plan.phases,
      artifactsCreated: false,
      message: detection.intent === "guidance"
        ? "Guidance no crea directorios, archivos ni runs de auditoría. La auditoría completa solo inicia desde la acción explícita."
        : "La intención detectada no inicia nada por sí sola: confirma el inicio de la auditoría desde esta sección.",
    };
  });

  // 2) Inicio explícito de una auditoría completa.
  app.post<{
    Body: {
      path?: unknown; instructions?: unknown; profile?: unknown; scope?: unknown;
      budget?: unknown; sourceRef?: unknown; sourceDirty?: unknown;
      preflightDepth?: unknown; auditorScope?: unknown;
      executionPolicy?: unknown; sandboxAuthorization?: unknown;
    };
  }>("/api/security-audit/runs", async (request, reply) => {
    const body = bodyOf(request.body);
    const projectPath = typeof body.path === "string" ? body.path.trim() : "";
    // Paquete 7: la instrucción es texto opcional acotado a 8000. Solo es un
    // dato contextual del operador: presupuesto, alcance y permisos siguen
    // viniendo EXCLUSIVAMENTE del formulario validado (scope/budget/policy).
    if (body.instructions !== undefined && body.instructions !== null
        && typeof body.instructions !== "string") {
      return reply.code(400).send({ error: "Las instrucciones deben ser un texto." });
    }
    const instructions = typeof body.instructions === "string" ? body.instructions.trim() : "";
    if (instructions.length > SECURITY_AUDIT_INSTRUCTIONS_MAX_CHARS) {
      return reply.code(400).send({
        error: `Las instrucciones superan el límite de ${SECURITY_AUDIT_INSTRUCTIONS_MAX_CHARS} caracteres.`,
      });
    }

    const admission = admissionChecks(deps, {
      projectPath, preflightDepth: body.preflightDepth,
    });
    if (admission) return reply.code(admission.status).send({ error: admission.error });

    const profile = typeof body.profile === "string" ? body.profile : "";
    const team = teamCheck(deps, profile);
    if (team) return reply.code(team.status).send({ error: team.error });

    let securityAuditOptions: StartExecutionOptions["securityAudit"];
    try {
      securityAuditOptions = validateSecurityAuditStartOptions({
        profile,
        scope: body.scope,
        budget: body.budget ?? undefined,
        // F10: si la API aporta sourceRef/sourceDirty se reenvían tal cual
        // para que validateStart los RECHACE con client_source_not_authoritative.
        sourceRef: body.sourceRef,
        sourceDirty: body.sourceDirty,
        executionPolicy: body.executionPolicy ?? "source-only",
        sandboxAuthorization: body.sandboxAuthorization ?? null,
      }) as StartExecutionOptions["securityAudit"];
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }

    let auditorScope: string;
    try {
      auditorScope = deps.validateCapabilityScopeInput(projectPath, body.auditorScope).declarations;
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }

    const consumed = await consumeAdmission(deps, {
      projectPath, preflightDepth: String(body.preflightDepth),
    });
    if (consumed) return reply.code(consumed.status).send({ error: consumed.error });

    try {
      const result = await deps.startExecution(
        projectPath,
        instructions || SECURITY_AUDIT_DEFAULT_INSTRUCTIONS,
        deps.factoryRoot,
        undefined,
        { securityAudit: securityAuditOptions, auditorScope },
      );
      // Paquete 8: el id se conoce al resolver startExecution; se marca ANTES
      // de responder 202 (y antes de que el orquestador cree la fila) para que
      // el primer sondeo del cliente nunca vea un 404 prematuro.
      markSecurityAuditPreparing(result.runId);
      // Paquete 8b: si una cancelación quedó pendiente para este id, se aplica
      // en cuanto la ejecución exista y se registra el resultado real.
      const pendingCancelApplied = applySecurityAuditPendingCancel(deps, result.runId);
      return reply.code(202).send({
        started: true,
        preparing: true,
        pendingCancelApplied,
        runId: result.runId,
        execution: deps.getExecution(result.runId),
        message: "Auditoría iniciada. Las seis fases avanzarán con instancias de solo lectura.",
      });
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // 3) Historial real (persistencia, sin fixtures).
  app.get<{ Querystring: { projectPath?: string } }>("/api/security-audit/runs", async (request, reply) => {
    const projectPath = typeof request.query?.projectPath === "string" ? request.query.projectPath : "";
    if (!projectPath || !isAbsolute(projectPath)) {
      return reply.code(400).send({ error: "Indica la ruta absoluta del proyecto (projectPath)." });
    }
    const runs = listSecurityAuditRuns(deps.getFactoryDatabase())
      .filter((row) => row.projectPath === projectPath)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(mapRunSummary);
    return { runs, projectPath };
  });

  // 4) Estado detallado.
  app.get<{ Params: { runId: string } }>("/api/security-audit/runs/:runId", async (request, reply) => {
    const runId = parseRunId(request.params.runId);
    if (!runId) return reply.code(400).send({ error: "Identificador de auditoría inválido." });
    // Paquete 8b: una cancelación pedida durante la preparación se aplica EN
    // CUANTA la fila existe (el helper solo actúa si la fila ya está en la BD,
    // consume la entrada una vez y persiste el flag real).
    applySecurityAuditPendingCancel(deps, runId);
    const status = buildStatusPayload(deps, runId);
    // Paquete 8: 404 de fila ausente. Si el id fue aceptado hace poco y su fila
    // aún no existe (el orquestador la crea de forma asíncrona), se responde
    // 202 "preparando" en vez de un 404 que la UI interpretaría como error.
    if (!status || (!status.ok && status.status === 404)) {
      if (isSecurityAuditPreparing(runId)) {
        return reply.code(202).send({
          preparing: true,
          runId,
          message: "La auditoría está en preparación.",
        });
      }
      return reply.code(404).send({ error: "Auditoría no encontrada." });
    }
    // El run ya existe en la BD: sale del registro de preparación.
    clearSecurityAuditPreparing(runId);
    if (!status.ok) return reply.code(status.status).send({ error: status.error });
    return status.payload;
  });

  // 5) Reanudación explícita.
  app.post<{ Params: { runId: string }; Body: { auditorScope?: unknown; sandboxAuthorization?: unknown } }>(
    "/api/security-audit/runs/:runId/resume",
    async (request, reply) => {
      const runId = parseRunId(request.params.runId);
      if (!runId) return reply.code(400).send({ error: "Identificador de auditoría inválido." });
      const db = deps.getFactoryDatabase();
      const run = getSecurityAuditRun(db, runId);
      if (!run) return reply.code(404).send({ error: "Auditoría no encontrada." });
      if (run.runStatus === "complete") {
        return reply.code(409).send({ error: "La auditoría ya está completa; no hay nada que reanudar." });
      }
      const team = teamCheck(deps, run.profile);
      if (team) return reply.code(team.status).send({ error: team.error });

      let auditorScope: string;
      try {
        auditorScope = deps.validateCapabilityScopeInput(run.projectPath, request.body?.auditorScope).declarations;
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
      }
      try {
        const storedBudget = (run.budgetConfig ?? {}) as Record<string, unknown>;
        // Paquete 7: la reanudación REUTILIZA la instrucción original del run
        // (execution run de origen); sin ella, el texto por defecto. Nunca se
        // inventa una instrucción nueva.
        const originalInstructions =
          effectiveInstructionsForRun(deps, runId) || SECURITY_AUDIT_DEFAULT_INSTRUCTIONS;
        const options = validateSecurityAuditStartOptions({
          profile: run.profile,
          scope: run.scope,
          budget: {
            maxInvocations: typeof storedBudget.maxInvocations === "number"
              || storedBudget.maxInvocations === null
              ? storedBudget.maxInvocations as number | null
              : null,
            maxConcurrency: typeof storedBudget.maxConcurrency === "number"
              ? storedBudget.maxConcurrency as number
              : run.maxConcurrency,
            maxDurationMs: typeof storedBudget.maxDurationMs === "number"
              ? storedBudget.maxDurationMs as number
              : run.maxDurationMs ?? 3_600_000,
          },
          resumeRunId: runId,
          // F10: la reanudación NO reenvía sourceRef/sourceDirty: el
          // orquestador resuelve el origen actual y compara la identidad con
          // la del run original (resume_source_changed si cambió).
          executionPolicy: run.executionPolicy,
          sandboxAuthorization: request.body?.sandboxAuthorization ?? null,
        }) as StartExecutionOptions["securityAudit"];
        const result = await deps.startExecution(
          run.projectPath,
          originalInstructions,
          deps.factoryRoot,
          undefined,
          { securityAudit: options, auditorScope },
        );
        return reply.code(202).send({
          resumed: true,
          runId,
          executionRunId: result.runId,
          execution: deps.getExecution(result.runId),
          message: "Reanudación iniciada: no se repiten fases completas ni sesiones previas.",
        });
      } catch (error) {
        return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
      }
    },
  );

  // 6) Cancelación reutilizando el motor de ejecuciones.
  app.post<{ Params: { runId: string } }>("/api/security-audit/runs/:runId/cancel", async (request, reply) => {
    const runId = parseRunId(request.params.runId);
    if (!runId) return reply.code(400).send({ error: "Identificador de auditoría inválido." });
    const db = deps.getFactoryDatabase();
    const run = getSecurityAuditRun(db, runId);
    if (!run) {
      // Paquete 8b: cancelar mientras la fila del run aún no existe (run en
      // preparación). Nunca se finge una cancelación efectiva.
      if (!isSecurityAuditPreparing(runId)) {
        return reply.code(404).send({ error: "Auditoría no encontrada." });
      }
      // Si la ejecución ya vive en el proceso, la cancelación es REAL por la
      // MISMA vía que la cancelación normal (sin duplicar lógica).
      const execution = activeAuditExecution(deps, runId);
      if (execution) {
        try {
          const result = await cancelAuditViaExecution(deps, db, runId, execution);
          // La fila de auditoría aún no existe: la persistencia de
          // `cancel_requested` queda pendiente y el GET la aplicará.
          markSecurityAuditPendingCancel(runId);
          return reply.code(202).send({
            ...result,
            preparing: true,
            cancelRequested: true,
            pendingCancelApplied: false,
          });
        } catch (error) {
          return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
        }
      }
      // Sin ejecución todavía: la intención queda REGISTRADA y se aplicará en
      // cuanto la fila exista.
      markSecurityAuditPendingCancel(runId);
      return reply.code(202).send({
        preparing: true,
        cancelRequested: true,
        pendingCancelApplied: false,
        runId,
        message: "Cancelación registrada; se aplicará en cuanto la auditoría exista.",
      });
    }
    const execution = activeAuditExecution(deps, runId);
    if (!execution) {
      return reply.code(409).send({
        error: "La auditoría no tiene una ejecución activa en este proceso; no se puede cancelar.",
      });
    }
    try {
      return await cancelAuditViaExecution(deps, db, runId, execution);
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // 7) Validación con los dos validadores oficiales.
  app.post<{ Params: { runId: string } }>("/api/security-audit/runs/:runId/validate", async (request, reply) => {
    const runId = parseRunId(request.params.runId);
    if (!runId) return reply.code(400).send({ error: "Identificador de auditoría inválido." });
    const db = deps.getFactoryDatabase();
    const run = getSecurityAuditRun(db, runId);
    if (!run) return reply.code(404).send({ error: "Auditoría no encontrada." });
    let layout;
    try {
      layout = resolveSecurityAuditRunDirectory(runId, run.projectPath);
    } catch {
      return reply.code(404).send({ error: "Los artefactos de la auditoría no están disponibles en esta máquina." });
    }
    try {
      const ledger = validateCoverageLedgerFile(layout.paths["coverage-ledger.json"], layout.runDir);
      const findings = validateFindingsFile(layout.paths["findings.json"], layout.runDir);
      setSecurityAuditValidators(db, runId, {
        ledger: ledger.status === "PASS" ? "pass" : "fail",
        findings: findings.status === "PASS" ? "pass" : "fail",
      });
      const okBoth = ledger.status === "PASS" && findings.status === "PASS";
      return {
        ok: okBoth,
        ledger: {
          status: ledger.status,
          exitCode: ledger.exitCode,
          summary: summaryOf(ledger.stdout, ledger.stderr),
        },
        findings: {
          status: findings.status,
          exitCode: findings.exitCode,
          summary: summaryOf(findings.stdout, findings.stderr),
        },
        message: okBoth
          ? "Ambos validadores oficiales aprueban los artefactos."
          : "Al menos un validador oficial rechazó los artefactos; revisa el detalle y vuelve a validar.",
      };
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // 8) Descarga de artefactos con allowlist y ruta confinada.
  app.get<{ Params: { runId: string; artifact: string } }>(
    "/api/security-audit/runs/:runId/reports/:artifact",
    async (request, reply) => {
      const runId = parseRunId(request.params.runId);
      if (!runId) return reply.code(400).send({ error: "Identificador de auditoría inválido." });
      const artifact = request.params.artifact;
      if (!ARTIFACT_PATTERN.test(artifact) ||
          !(SECURITY_AUDIT_REPORT_ARTIFACTS as readonly string[]).includes(artifact)) {
        return reply.code(404).send({ error: "Artefacto no permitido para descarga." });
      }
      try {
        const run = getSecurityAuditRun(deps.getFactoryDatabase(), runId);
        if (!run) return reply.code(404).send({ error: "Auditoría no encontrada." });
        const layout = resolveSecurityAuditRunDirectory(runId, run.projectPath);
        const content = readSecurityAuditArtifact(layout, artifact as SecurityAuditReportArtifact);
        const filename = artifact.replace(/[^A-Za-z0-9._-]/g, "_");
        reply.header("Cache-Control", "no-store");
        reply.header("X-Content-Type-Options", "nosniff");
        reply.header("Content-Disposition", `attachment; filename="${filename}"`);
        return reply.type(ARTIFACT_CONTENT_TYPES[artifact as SecurityAuditReportArtifact]).send(content);
      } catch {
        return reply.code(404).send({ error: "Artefacto no disponible para esta auditoría." });
      }
    },
  );

  // 9) Historial de remediaciones.
  app.get<{ Params: { runId: string } }>(
    "/api/security-audit/runs/:runId/remediations",
    async (request, reply) => {
      const runId = parseRunId(request.params.runId);
      if (!runId) return reply.code(400).send({ error: "Identificador de auditoría inválido." });
      const db = deps.getFactoryDatabase();
      if (!getSecurityAuditRun(db, runId)) {
        return reply.code(404).send({ error: "Auditoría no encontrada." });
      }
      return {
        remediations: listSecurityAuditRemediations(db, runId).map((remediation) => ({
          fingerprint: remediation.fingerprint,
          state: remediation.state,
          executionRunId: remediation.executionRunId,
          evidenceCount: remediation.evidence.length,
          createdAt: remediation.createdAt,
          updatedAt: remediation.updatedAt,
          completedAt: remediation.completedAt,
        })),
      };
    },
  );

  // 10) Remediación: ejecución tradicional independiente.
  app.post<{
    Params: { runId: string };
    Body: {
      fingerprints?: unknown; approved?: unknown; path?: unknown;
      preflightDepth?: unknown; auditorScope?: unknown; notes?: unknown;
    };
  }>("/api/security-audit/runs/:runId/remediations", async (request, reply) => {
    const runId = parseRunId(request.params.runId);
    if (!runId) return reply.code(400).send({ error: "Identificador de auditoría inválido." });
    const body = bodyOf(request.body);
    if (body.approved !== true) {
      return reply.code(400).send({
        error: "Confirma explícitamente la remediación (approved: true) antes de continuar.",
      });
    }
    const rawFingerprints = Array.isArray(body.fingerprints) ? body.fingerprints : [];
    const fingerprints = [...new Set(rawFingerprints
      .filter((item): item is string => typeof item === "string" && FINGERPRINT_PATTERN.test(item)))];
    if (fingerprints.length === 0 || fingerprints.length !== rawFingerprints.length) {
      return reply.code(400).send({
        error: "Indica al menos un fingerprint válido de un hallazgo confirmado.",
      });
    }

    const db = deps.getFactoryDatabase();
    const run = getSecurityAuditRun(db, runId);
    if (!run) return reply.code(404).send({ error: "Auditoría no encontrada." });
    // F07: SOLO hallazgos `confirmed` ACTIVOS de la proyección (exacta del
    // findings.json publicado). El historial append-only es evidencia de
    // reemplazos y retiros: un registro retirado de la proyección nunca es
    // remediable desde aquí.
    const findings = listSecurityAuditFindings(db, runId);
    const byFingerprint = new Map(findings.map((finding) => [finding.fingerprint, finding]));
    const notConfirmed = fingerprints.filter((fingerprint) =>
      byFingerprint.get(fingerprint)?.verdict !== "confirmed");
    if (notConfirmed.length > 0) {
      return reply.code(409).send({
        error:
          "Solo se remedian hallazgos confirmed explícitos. Sin confirmar: " +
          notConfirmed.join(", ") + ".",
      });
    }
    const alreadyOpen = listSecurityAuditRemediations(db, runId)
      .filter((remediation) => fingerprints.includes(remediation.fingerprint));
    if (alreadyOpen.length > 0) {
      return reply.code(409).send({
        error: "Ya existe una remediación registrada para: " +
          alreadyOpen.map((remediation) => remediation.fingerprint).join(", ") + ".",
      });
    }

    // N3: la ruta opcional debe coincidir canónicamente con la de la auditoría.
    const requestedPath = typeof body.path === "string" && body.path.trim()
      ? body.path.trim() : null;
    if (requestedPath && resolve(requestedPath) !== resolve(run.projectPath)) {
      return reply.code(400).send({
        error: "La ruta de la remediación debe coincidir exactamente con la de la auditoría.",
      });
    }
    const projectPath = run.projectPath;
    const notes = typeof body.notes === "string" ? body.notes.trim().slice(0, 4000) : "";
    const instructions = [
      "REMEDIACIÓN INDEPENDIENTE de una auditoría de seguridad previa.",
      "Corrige únicamente estos hallazgos confirmed con la corrección mínima en la fuente:",
      ...fingerprints.map((fingerprint) => `- ${fingerprint}`),
      "No modifiques áreas fuera de esos hallazgos y no toques la configuración global de la fábrica.",
      notes ? "Notas del operador: " + notes : "",
    ].filter(Boolean).join("\n");

    // `approved: true` es una autorización explícita nueva: permite reutilizar
    // la preconsulta ya consumida por la auditoría, pero el resto de controles
    // (ruta, profundidad, favoritos, decisión y equipo) se revalidan igual.
    const admission = admissionChecks(deps, {
      projectPath, preflightDepth: body.preflightDepth, allowConsumed: true,
    });
    if (admission) return reply.code(admission.status).send({ error: admission.error });
    const writers = writerTeamCheck(deps, instructions);
    if (writers) return reply.code(writers.status).send({ error: writers.error });

    let auditorScope: string;
    try {
      auditorScope = deps.validateCapabilityScopeInput(projectPath, body.auditorScope).declarations;
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
    const revalidated = await consumeAdmission(deps, {
      projectPath, preflightDepth: String(body.preflightDepth), consume: false,
    });
    if (revalidated) return reply.code(revalidated.status).send({ error: revalidated.error });

    try {
      const result = await deps.startExecution(
        projectPath,
        instructions,
        deps.factoryRoot,
        undefined,
        { auditorScope, securityRemediation: { auditRunId: runId, fingerprints } },
      );
      const created = fingerprints.map((fingerprint) => {
        createSecurityAuditRemediation(db, {
          runId,
          fingerprint,
          executionRunId: result.runId,
        });
        transitionSecurityAuditRemediation(db, runId, fingerprint, "in_progress");
        return { fingerprint, executionRunId: result.runId, state: "in_progress" as const };
      });
      return reply.code(202).send({
        started: true,
        runId,
        executionRunId: result.runId,
        execution: deps.getExecution(result.runId),
        remediations: created,
        note: "La ejecución exitosa NO equivale a verified_fixed: se requiere una revalidación posterior con evidencia verificable.",
      });
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // 11) Revalidación: única vía a verified_fixed. La evidencia se DERIVA de un
  // run de verificación completo del mismo proyecto; nunca se acepta evidencia
  // arbitraria del cliente. F09: la evidencia phase5 debe ser del fingerprint
  // EXACTO con sesión/handoff/agentRun reales y posterior a la ejecución de la
  // remediación (que debe existir y estar terminal succeeded); el alcance del
  // run de verificación debe cubrir la ubicación del hallazgo original y la
  // versión del código debe ser posterior (commit nuevo o worktree dirty
  // verificado tras el cambio).
  app.post<{
    Params: { runId: string; fingerprint: string };
    Body: { verificationAuditRunId?: unknown };
  }>("/api/security-audit/runs/:runId/remediations/:fingerprint/revalidate", async (request, reply) => {
    const runId = parseRunId(request.params.runId);
    const fingerprint = request.params.fingerprint;
    if (!runId || !FINGERPRINT_PATTERN.test(fingerprint)) {
      return reply.code(400).send({ error: "Identificador o fingerprint inválido." });
    }
    const body = bodyOf(request.body);
    const verificationRunId = parseRunId(body.verificationAuditRunId);
    if (!verificationRunId) {
      return reply.code(400).send({
        error: "verified_fixed exige verificationAuditRunId de un run de auditoría completo.",
      });
    }
    const db = deps.getFactoryDatabase();
    const auditRun = getSecurityAuditRun(db, runId);
    if (!auditRun) return reply.code(404).send({ error: "Auditoría no encontrada." });
    const remediation = listSecurityAuditRemediations(db, runId)
      .find((item) => item.fingerprint === fingerprint);
    if (!remediation) {
      return reply.code(404).send({ error: "Remediación no registrada para este fingerprint." });
    }
    if (verificationRunId === runId) {
      return reply.code(409).send({
        error: "La verificación debe ser otra corrida de auditoría distinta de la original.",
      });
    }
    const verificationRun = getSecurityAuditRun(db, verificationRunId);
    if (!verificationRun) {
      return reply.code(409).send({ error: "El run de verificación no existe." });
    }
    if (verificationRun.projectPath !== auditRun.projectPath) {
      return reply.code(409).send({ error: "El run de verificación debe ser del mismo proyecto." });
    }
    if (verificationRun.runStatus !== "complete") {
      return reply.code(409).send({ error: "El run de verificación debe estar completo." });
    }
    if (verificationRun.ledgerValidator !== "pass" || verificationRun.findingsValidator !== "pass") {
      return reply.code(409).send({
        error: "El run de verificación debe tener ambos validadores oficiales en PASS.",
      });
    }
    const verificationRecord = listSecurityAuditFindings(db, verificationRunId)
      .find((item) => item.fingerprint === fingerprint);
    if (!verificationRecord || verificationRecord.verdict !== "rejected") {
      return reply.code(409).send({
        error: "El fingerprint debe aparecer con verdict rejected en el run de verificación.",
      });
    }

    // F09: el registro ORIGINAL debe seguir en la proyección y con una
    // ubicación verificable dentro del proyecto de la auditoría.
    const originalRecord = listSecurityAuditFindings(db, runId)
      .find((item) => item.fingerprint === fingerprint);
    if (!originalRecord) {
      return reply.code(409).send({
        error: "El fingerprint ya no existe en la proyección de la auditoría original.",
      });
    }
    const rawLocationPath = findingLocationPath(originalRecord.payload);
    if (!rawLocationPath) {
      return reply.code(409).send({
        error: "El hallazgo original no tiene una ubicación (location) verificable; no se puede revalidar.",
      });
    }
    const findingPath = findingRelativePath(auditRun.projectPath, rawLocationPath);
    if (!findingPath) {
      return reply.code(409).send({
        error: "La ubicación del hallazgo original está fuera del proyecto de la auditoría.",
      });
    }

    // F09: la ejecución de remediación debe existir y estar terminal
    // `succeeded`; el éxito de implementación por sí solo nunca es evidencia.
    if (!remediation.executionRunId) {
      return reply.code(409).send({
        error: "La remediación no tiene una ejecución vinculada; no se puede revalidar.",
      });
    }
    const remediationExecution = deps.getExecution(remediation.executionRunId);
    if (!remediationExecution) {
      return reply.code(409).send({
        error: "La ejecución de la remediación no existe.",
      });
    }
    if (remediationExecution.run.status !== "succeeded") {
      return reply.code(409).send({
        error:
          "La ejecución de la remediación no terminó en estado terminal succeeded " +
          `(estado real: ${remediationExecution.run.status}); no se puede revalidar.`,
      });
    }
    const remediationFinishedAt = remediationExecution.run.finishedAt;
    if (!remediationFinishedAt) {
      return reply.code(409).send({
        error: "La ejecución de la remediación no tiene fecha de finalización; no se puede revalidar.",
      });
    }

    // La verificación debe ser POSTERIOR a la finalización de la remediación.
    if (verificationRun.createdAt <= remediationFinishedAt) {
      return reply.code(409).send({
        error: "El run de verificación no es posterior a la finalización de la remediación.",
      });
    }

    // F09: la evidencia phase5 debe ser de ESTE fingerprint; la phase5 de otro
    // hallazgo del run de verificación no cuenta.
    const invocations = listSecurityAuditInvocations(db, verificationRunId);
    const phase5ForFingerprint = invocations.filter((item) =>
      item.verificationKind === "phase5"
      && item.fingerprint === fingerprint
      && item.outcome === "succeeded");
    if (phase5ForFingerprint.length === 0) {
      return reply.code(409).send({
        error:
          "El run de verificación no tiene una invocación phase5 exitosa para este fingerprint; " +
          "la evidencia phase5 de otro hallazgo no cuenta.",
      });
    }
    // Identidad real: sesión, handoff y agentRun persistidos.
    const phase5WithRealIdentity = phase5ForFingerprint.filter((item) =>
      isRealIdentifier(item.sessionId)
      && isRealIdentifier(item.handoffId)
      && isRealIdentifier(item.agentRunId));
    if (phase5WithRealIdentity.length === 0) {
      return reply.code(409).send({
        error:
          "Las invocaciones phase5 exitosas no tienen sesión, handoff y agentRun reales " +
          "en el run de verificación.",
      });
    }
    // La instancia phase5 debe terminar DESPUÉS de la remediación.
    const phase5Evidence = phase5WithRealIdentity.filter((item) =>
      item.finishedAt !== null && item.finishedAt > remediationFinishedAt);
    if (phase5Evidence.length === 0) {
      return reply.code(409).send({
        error:
          "Las invocaciones phase5 exitosas no terminan después de la finalización " +
          "de la ejecución de remediación.",
      });
    }

    // Un proceso exitoso no implica que su respuesta haya sido aceptada.
    const acceptedHash = createHash("sha256").update(JSON.stringify(verificationRecord.payload)).digest("hex");
    const acceptedPhase5 = phase5Evidence.filter((item) =>
      item.crossEngineEvidence?.fingerprint === fingerprint &&
      item.crossEngineEvidence.acceptedRecordSha256 === acceptedHash &&
      item.crossEngineEvidence.verifier.instanceId === item.instanceId &&
      item.crossEngineEvidence.verifier.sessionId === item.sessionId &&
      item.crossEngineEvidence.verifier.handoffId === item.handoffId &&
      item.crossEngineEvidence.verifier.agentRunId === item.agentRunId);
    if (acceptedPhase5.length === 0) {
      return reply.code(409).send({ error: "No hay evidencia phase5 de aceptación del registro rejected publicado." });
    }

    // F09: el alcance REAL del run de verificación debe cubrir la ubicación
    // del hallazgo original (mismo proyecto ya validado).
    if (!scopeCoversPath(verificationRun.scope, findingPath)) {
      return reply.code(409).send({
        error:
          "El alcance del run de verificación no cubre la ubicación del hallazgo original " +
          `(${findingPath}).`,
      });
    }

    // F09: la verificación debe apoyar una versión posterior del código: un
    // sourceRef resuelto distinto al original o un worktree dirty verificado
    // después del cambio. La misma versión limpia del original nunca revalida.
    const versionChanged = verificationRun.sourceRef !== null
      && verificationRun.sourceRef !== auditRun.sourceRef;
    const dirtyPosterior = verificationRun.sourceDirty === true;
    if (!versionChanged && !dirtyPosterior) {
      return reply.code(409).send({
        error:
          "El run de verificación no refleja una versión posterior del código " +
          "(exige un sourceRef resuelto distinto al original o un worktree dirty " +
          "con la verificación posterior al cambio); la misma versión limpia no revalida.",
      });
    }

    let originalSnapshot: ReturnType<typeof readSecurityAuditSourceSnapshot>;
    let verificationSnapshot: ReturnType<typeof readSecurityAuditSourceSnapshot>;
    try {
      originalSnapshot = readSecurityAuditSourceSnapshot(resolveSecurityAuditRunDirectory(runId, auditRun.projectPath));
      verificationSnapshot = readSecurityAuditSourceSnapshot(resolveSecurityAuditRunDirectory(verificationRunId, verificationRun.projectPath));
    } catch {
      originalSnapshot = null;
      verificationSnapshot = null;
    }
    const originalFile = originalSnapshot?.files.find((item) => item.path === findingPath);
    const verificationFile = verificationSnapshot?.files.find((item) => item.path === findingPath);
    if (!originalFile || !verificationFile || originalFile.sha256 === verificationFile.sha256) {
      return reply.code(409).send({ error: "No se conserva evidencia de contenido posterior distinto para la ruta del hallazgo; no se marca verified_fixed." });
    }

    // La evidencia se DERIVA íntegramente de los datos persistidos del run.
    const evidence = [{
      fingerprint,
      verificationAuditRunId: verificationRunId,
      verdict: "rejected",
      ledgerValidator: "pass",
      findingsValidator: "pass",
      phase5Instances: acceptedPhase5.map((item) => item.instanceId),
      verificationSourceRef: verificationRun.sourceRef,
      verificationSourceDirty: verificationRun.sourceDirty,
      verificationScope: verificationRun.scope,
      findingPath,
      originalFileSha256: originalFile.sha256,
      verificationFileSha256: verificationFile.sha256,
      remediationExecutionRunId: remediation.executionRunId,
      verifiedAt: new Date().toISOString(),
    }];
    try {
      transitionSecurityAuditRemediation(db, runId, fingerprint, "verified_fixed", evidence);
      return {
        updated: true,
        runId,
        fingerprint,
        state: "verified_fixed",
        evidenceSource: verificationRunId,
      };
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}

function summaryOf(stdout: string, stderr: string): string {
  const combined = (stdout + stderr).trim();
  if (!combined) return "Sin salida del validador.";
  const line = combined.split(/\r?\n/).find((item) => /^(PASS|FAIL|ERROR)/.test(item.trim()));
  return (line ?? combined).trim().slice(0, 400);
}

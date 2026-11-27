/**
 * Helpers puros de la sección SECURITY OPERATIONS (sin React y sin red).
 * El componente `SecurityOperations.tsx` los usa para etiquetar estados
 * reales devueltos por la API; aquí no hay datos de ejemplo.
 */

export type SecurityAuditProfile = "quick" | "standard" | "deep";
export type SecurityAuditScopeKind = "project" | "directory" | "component" | "domain" | "git-diff";

/** Dominios oficiales = nombres de los documentos companion de la skill. */
export const SECURITY_AUDIT_DOMAINS = [
  "AI-AND-LLM",
  "CLIENT-SIDE",
  "CLOUD-AND-DEPLOYMENT",
  "DATA-ISOLATION-AND-LIFECYCLE",
  "DESKTOP-MOBILE-AND-LOCAL-IPC",
  "MEMORY-SAFETY-AND-BINARY",
  "PROTOCOLS-RPC-AND-MESSAGING",
  "RESOURCE-EXHAUSTION-AND-AVAILABILITY",
  "SUPPLY-CHAIN-AND-RELEASE",
  "WEB-PROTOCOL-AND-AUTH",
] as const;

export const SECURITY_AUDIT_SCOPE_KINDS = [
  "project", "directory", "component", "domain", "git-diff",
] as const;

export const SECURITY_AUDIT_PHASES: ReadonlyArray<{ phase: number; label: string }> = [
  { phase: 1, label: "Reconocimiento" },
  { phase: 2, label: "Olas de caza" },
  { phase: 3, label: "Validación de candidatos" },
  { phase: 4, label: "Salida estructurada" },
  { phase: 5, label: "Verificación de registros" },
  { phase: 6, label: "Informe objetivo" },
];

/** Allowlist de descargas (el servidor vuelve a validarla). */
export const SECURITY_AUDIT_REPORT_FILES = [
  "run-metadata.json",
  "architecture.md",
  "coverage-ledger.json",
  "findings.json",
  "REPORT.md",
  "FINDINGS-DETAIL.md",
  "NEEDS-VALIDATION.md",
] as const;

const PHASE_STATE_LABELS: Record<string, string> = {
  pending: "Pendiente",
  in_progress: "En curso",
  complete: "Completada",
  skipped: "Omitida",
  // Paquete 6: estados reales del desglose por fase. Una fase parcial o
  // bloqueada JAMÁS se rotula como "Completada". "completed" es el estado del
  // desglose por fase (`phaseStates`); "complete", el del checkpoint.
  completed: "Completada",
  partial: "Parcial",
  blocked: "Bloqueada",
  not_applicable: "No aplicable",
};

const RUN_STATUS_LABELS: Record<string, string> = {
  in_progress: "En curso",
  complete: "Completa",
  incomplete: "Incompleta",
};

const INCOMPLETE_REASON_LABELS: Record<string, string> = {
  budget_cannot_fund_reconnaissance_and_reserves:
    "El presupuesto no cubre reconocimiento y reservas; no se invocó a ningún agente.",
  budget_cannot_reserve_critics_and_validation:
    "No hay presupuesto para reservar críticos y validación en una ola posterior.",
  critic_budget_exhausted: "El presupuesto agotó los críticos obligatorios.",
  validation_budget_exhausted: "El presupuesto agotó la validación de candidatos.",
  provider_unavailable: "El proveedor no está disponible o agotó su cuota.",
  cancelled_by_user: "Cancelada por el operador.",
  deadline_exceeded: "Se alcanzó el límite de tiempo.",
  execution_interrupted: "La ejecución fue interrumpida.",
  validator_failed: "Un validador oficial rechazó los artefactos.",
  orchestrator_failed: "El orquestador no pudo completar la auditoría.",
  candidate_validation_incomplete: "Quedaron candidatos sin validación independiente aceptada.",
  coverage_incomplete: "Quedaron unidades de cobertura pendientes.",
};

const SEVERITY_LABELS: Record<string, string> = {
  critical: "Crítica",
  high: "Alta",
  medium: "Media",
  low: "Baja",
  informational: "Informativa",
  sin_clasificar: "Sin clasificar",
};

const OUTCOME_LABELS: Record<string, string> = {
  running: "En curso",
  succeeded: "Completada",
  failed: "Fallida",
  cancelled: "Cancelada",
};

export function securityAuditPhaseLabel(state: string): string {
  return PHASE_STATE_LABELS[state] ?? state;
}

export function securityAuditRunStatusLabel(status: string): string {
  return RUN_STATUS_LABELS[status] ?? status;
}

export function securityAuditIncompleteReasonLabel(reason: string | null | undefined): string {
  if (!reason) return "";
  return INCOMPLETE_REASON_LABELS[reason] ?? reason;
}

export function securityAuditSeverityLabel(severity: string | null | undefined): string {
  if (!severity) return "Sin clasificar";
  return SEVERITY_LABELS[severity] ?? severity;
}

export function securityAuditOutcomeLabel(outcome: string): string {
  return OUTCOME_LABELS[outcome] ?? outcome;
}

/** Implementation status is derived from its linked execution, not from
 * evidence of security revalidation. Never infer verified_fixed from success. */
export function securityAuditRemediationLabel(state: string, executionStatus?: string | null): string {
  if (state === "verified_fixed") return "Corrección verificada";
  if (state === "rejected") return "Rechazada";
  if (state === "revalidated") return "Revalidada";
  if (state === "requested" || state === "in_progress") {
    if (executionStatus === "succeeded") return "Implementación completada · pendiente de revalidación";
    if (executionStatus === "failed") return "Implementación fallida";
    if (executionStatus === "cancelled") return "Implementación cancelada";
    if (executionStatus === "interrupted") return "Implementación interrumpida";
    if (executionStatus === "waiting") return "Implementación esperando autorización";
    if (executionStatus === "running") return "Implementación en ejecución";
    if (executionStatus === "queued") return "Implementación en cola";
    return "Estado de implementación no disponible";
  }
  return state;
}

export function securityAuditProgress(phases: readonly string[]): {
  completed: number;
  total: number;
  percent: number;
} {
  const completed = phases.filter((state) => state === "complete").length;
  const total = SECURITY_AUDIT_PHASES.length;
  return { completed, total, percent: Math.round((completed / total) * 100) };
}

/**
 * Paquete 6 (refinamiento): primera parte de la línea de progreso.
 * - Run `complete`: se mantiene "Progreso N/6 fases (P%)".
 * - Run NO complete: recorrer las fases NO es completarlas; JAMÁS se muestra
 *   "100%" como progreso efectivo. "Recorridas" = fases que la corrida abrió
 *   (checkpoint distinto de pending); "Completadas" = estado REAL del
 *   desglose por fase (`realCompleted`); sin desglose (API antigua) se usa el
 *   checkpoint como único dato disponible.
 */
export function securityAuditProgressSummary(
  runStatus: string,
  phases: readonly string[],
  realCompleted?: number,
): string {
  const total = SECURITY_AUDIT_PHASES.length;
  if (runStatus === "complete") {
    const completed = phases.filter((state) => state === "complete").length;
    return `Progreso ${completed}/${total} fases (${Math.round((completed / total) * 100)}%)`;
  }
  const visited = phases.filter((state) => state !== "pending").length;
  const completed = Math.min(
    Math.max(realCompleted ?? phases.filter((state) => state === "complete").length, 0),
    total,
  );
  return `Fases recorridas: ${visited}/${total} · Completadas: ${completed}/${total}`;
}

export interface SecurityAuditPhaseBreakdown {
  completed: number;
  partial: number;
  blocked: number;
  notApplicable: number;
  pending: number;
}

/**
 * Paquete 6: desglose por estado real de las fases (estados distintos de
 * `complete`/`pending` que no existen en el checkpoint se cuentan como
 * pendientes). Recorrer las fases no equivale a completarlas.
 */
export function securityAuditPhaseBreakdown(
  phaseStates: ReadonlyArray<{ state: string }>,
): SecurityAuditPhaseBreakdown {
  const breakdown: SecurityAuditPhaseBreakdown = {
    completed: 0, partial: 0, blocked: 0, notApplicable: 0, pending: 0,
  };
  for (const entry of phaseStates) {
    if (entry.state === "completed") breakdown.completed += 1;
    else if (entry.state === "partial") breakdown.partial += 1;
    else if (entry.state === "blocked") breakdown.blocked += 1;
    else if (entry.state === "not_applicable") breakdown.notApplicable += 1;
    else breakdown.pending += 1;
  }
  return breakdown;
}

/**
 * Paquete 6: separa el motivo primario del resto. Con API antigua (sin
 * `incompleteReasons`) la lista adicional queda vacía; sin primario explícito
 * se usa el primero de la lista.
 */
export function splitSecurityAuditIncompleteReasons(
  primary: string | null | undefined,
  reasons: readonly string[] | undefined,
): { primary: string | null; additional: string[] } {
  const valid = (reasons ?? []).filter((reason): reason is string =>
    typeof reason === "string" && reason.length > 0);
  const main = primary && primary.length > 0 ? primary : valid[0] ?? null;
  return { primary: main, additional: valid.filter((reason) => reason !== main) };
}

/**
 * Paquete 6: `incompleteReasons` se expone en la RAÍZ del payload de estado
 * (`status.incompleteReasons`); `run.incompleteReasons` se acepta solo por
 * compatibilidad con payloads antiguos.
 */
export function securityAuditStatusIncompleteReasons(
  status: {
    incompleteReasons?: readonly string[];
    run?: { incompleteReason?: string | null; incompleteReasons?: readonly string[] };
  } | null | undefined,
): readonly string[] | undefined {
  return status?.incompleteReasons ?? status?.run?.incompleteReasons;
}

/** Sondear hasta el estado terminal, incluso durante una cancelación solicitada. */
export function shouldPollSecurityAudit(
  run: { runStatus?: string; cancelRequested?: boolean } | null | undefined,
): boolean {
  if (!run) return false;
  return run.runStatus === "in_progress";
}

/** Paquete 8: resultado clasificado de un sondeo de estado de auditoría. */
export type SecurityAuditPollOutcome = "ready" | "preparing" | "missing" | "stale";

/**
 * Paquete 8: helper PURO que clasifica la respuesta de un sondeo de
 * `GET /api/security-audit/runs/:runId` sin efectos ni estados inventados:
 * - `"stale"`: la respuesta pertenece a una generación anterior (otro run
 *   seleccionado u otra petición) y DEBE descartarse sin tocar el estado.
 * - `"preparing"`: el `202` con `preparing: true` de la API (la fila del run
 *   aún no existe; el orquestador la creará de forma asíncrona).
 * - `"ready"`: estado completo (`200`).
 * - `"missing"`: 404 real (identificador no existente y sin preparación).
 */
export function resolveSecurityAuditPollOutcome(
  status: number,
  body: unknown,
  isCurrent: boolean,
): SecurityAuditPollOutcome {
  if (!isCurrent) return "stale";
  if (typeof body === "object" && body !== null
      && (body as { preparing?: unknown }).preparing === true) {
    return "preparing";
  }
  return status === 200 ? "ready" : "missing";
}

export function securityAuditReportUrl(runId: string, artifact: string): string {
  // Segmentos no permitidos se degradan a marcadores inválidos: la URL jamás
  // contiene traversal (el servidor vuelve a validar el allowlist).
  const safeRunId = /^[A-Za-z0-9-]{1,64}$/.test(runId) ? runId : "invalid-run";
  const safeArtifact = (SECURITY_AUDIT_REPORT_FILES as readonly string[]).includes(artifact)
    ? artifact
    : "invalid-artifact";
  return `/api/security-audit/runs/${encodeURIComponent(safeRunId)}/reports/${encodeURIComponent(safeArtifact)}`;
}

export function formatSecurityAuditTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export function securityAuditScopeRequiresPaths(kind: SecurityAuditScopeKind): boolean {
  return kind === "directory" || kind === "component";
}

export function securityAuditScopeRequiresRefs(kind: SecurityAuditScopeKind): boolean {
  return kind === "git-diff";
}

export interface SecurityAuditScopeDraft {
  kind: SecurityAuditScopeKind;
  pathsText: string;
  domains: readonly string[];
  baseRef: string;
  headRef: string;
}

export interface SecurityAuditStartPayloadInput {
  projectPath: string;
  researchDepth: string;
  profile: SecurityAuditProfile;
  scope: Record<string, unknown>;
  budget: { maxInvocations: number | null; maxConcurrency: number; maxDurationMs: number };
  /** Paquete 7: instrucción del operador (opcional; se recorta, se acota a 8000 y se omite si queda vacía). */
  instructions?: string;
}

/** Paquete 7: mismo límite que valida la API para las instrucciones. */
export const SECURITY_AUDIT_INSTRUCTIONS_MAX_CHARS = 8000;

/**
 * Payload exacto que la UI envía a `POST /api/security-audit/runs`.
 * `preflightDepth` debe coincidir con la preconsulta real del proyecto.
 * Paquete 7: `instructions` se recorta (trim) y se ACOTA al límite de 8000
 * caracteres conservando el PREFIJO, de modo que el payload nunca excede lo
 * que la API acepta. SOLO se incluye si queda texto (vacío -> se omite para
 * que la API use su texto por defecto).
 */
export function buildSecurityAuditStartPayload(
  input: SecurityAuditStartPayloadInput,
): Record<string, unknown> {
  const trimmed = typeof input.instructions === "string" ? input.instructions.trim() : "";
  // Paquete 7 (revisión): el trim NO basta; el texto se acota al límite con
  // slice conservando el prefijo (nunca lanza: el exceso se pierde y punto).
  const instructions = trimmed.slice(0, SECURITY_AUDIT_INSTRUCTIONS_MAX_CHARS);
  return {
    path: input.projectPath,
    profile: input.profile,
    scope: input.scope,
    budget: input.budget,
    preflightDepth: input.researchDepth,
    ...(instructions ? { instructions } : {}),
  };
}

export interface SecurityAuditRemediationPayloadInput {
  projectPath: string;
  researchDepth: string;
  fingerprints: readonly string[];
  notes?: string;
}

/** Payload exacto de `POST /api/security-audit/runs/:runId/remediations`. */
export function buildSecurityAuditRemediationPayload(
  input: SecurityAuditRemediationPayloadInput,
): Record<string, unknown> {
  return {
    ...(input.notes?.trim() ? { notes: input.notes.trim().slice(0, 4000) } : {}),
    fingerprints: [...input.fingerprints],
    approved: true,
    path: input.projectPath,
    preflightDepth: input.researchDepth,
  };
}

/** Convierte el borrador del formulario en el objeto de alcance de la API. */
export function buildSecurityAuditScope(draft: SecurityAuditScopeDraft):
  | { ok: true; scope: Record<string, unknown> }
  | { ok: false; error: string } {
  const paths = draft.pathsText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (draft.kind === "project") return { ok: true, scope: { kind: "project" } };
  if (draft.kind === "directory" || draft.kind === "component") {
    if (paths.length === 0) {
      return { ok: false, error: "Indica al menos una ruta para este tipo de alcance." };
    }
    return { ok: true, scope: { kind: draft.kind, scopePaths: paths } };
  }
  if (draft.kind === "domain") {
    if (draft.domains.length === 0) {
      return { ok: false, error: "Selecciona al menos un dominio oficial." };
    }
    return { ok: true, scope: { kind: "domain", domains: [...draft.domains] } };
  }
  if (!draft.baseRef.trim() || !draft.headRef.trim()) {
    return { ok: false, error: "git-diff necesita baseRef y headRef." };
  }
  if (draft.baseRef.trim() === draft.headRef.trim()) {
    return { ok: false, error: "baseRef y headRef deben ser distintos." };
  }
  return {
    ok: true,
    scope: {
      kind: "git-diff",
      baseRef: draft.baseRef.trim(),
      headRef: draft.headRef.trim(),
      scopePaths: paths,
    },
  };
}

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

export function securityAuditProgress(phases: readonly string[]): {
  completed: number;
  total: number;
  percent: number;
} {
  const completed = phases.filter((state) => state === "complete").length;
  const total = SECURITY_AUDIT_PHASES.length;
  return { completed, total, percent: Math.round((completed / total) * 100) };
}

/** Sondear hasta el estado terminal, incluso durante una cancelación solicitada. */
export function shouldPollSecurityAudit(
  run: { runStatus?: string; cancelRequested?: boolean } | null | undefined,
): boolean {
  if (!run) return false;
  return run.runStatus === "in_progress";
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
}

/**
 * Payload exacto que la UI envía a `POST /api/security-audit/runs`.
 * `preflightDepth` debe coincidir con la preconsulta real del proyecto.
 */
export function buildSecurityAuditStartPayload(
  input: SecurityAuditStartPayloadInput,
): Record<string, unknown> {
  return {
    path: input.projectPath,
    profile: input.profile,
    scope: input.scope,
    budget: input.budget,
    preflightDepth: input.researchDepth,
  };
}

export interface SecurityAuditRemediationPayloadInput {
  projectPath: string;
  researchDepth: string;
  fingerprints: readonly string[];
}

/** Payload exacto de `POST /api/security-audit/runs/:runId/remediations`. */
export function buildSecurityAuditRemediationPayload(
  input: SecurityAuditRemediationPayloadInput,
): Record<string, unknown> {
  return {
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

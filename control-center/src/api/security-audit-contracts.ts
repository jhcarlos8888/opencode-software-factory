/**
 * Contratos del flujo `security-audit` de la fábrica: tipos estrictos y
 * validación runtime. Este módulo NO reimplementa el esquema upstream
 * (`report-schema.json`) ni ejecuta validadores; para eso existe
 * `security-audit-upstream.ts`.
 *
 * Fuentes oficiales (skill upstream `.opencode/skills/security-audit/`):
 * - intenciones y modos: `SKILL.md` § Operating modes;
 * - perfiles y alcance: `SKILL.md` § Run profiles and scope;
 * - fases: `SKILL.md` § Full audit workflow (seis fases, en orden);
 * - estados y motivos: `SKILL.md` § Full audit workflow (terminal states);
 * - dominios: nombres de los documentos companion con sección
 *   `When to use this file` (ver `ATTACK-CLASSES.md`).
 *
 * `guidance` no crea archivos ni plan de seis fases; `full_audit` sí.
 * `remediation` exige fingerprints y produce una solicitud independiente que
 * nunca modifica el target en auditoría.
 */

export const SECURITY_AUDIT_INTENTS = ["guidance", "full_audit", "remediation"] as const;
export type SecurityAuditIntent = (typeof SECURITY_AUDIT_INTENTS)[number];

export const SECURITY_AUDIT_PROFILES = ["quick", "standard", "deep"] as const;
export type SecurityAuditProfile = (typeof SECURITY_AUDIT_PROFILES)[number];

export const SECURITY_AUDIT_SCOPE_KINDS = [
  "project",
  "directory",
  "component",
  "domain",
  "git-diff",
] as const;
export type SecurityAuditScopeKind = (typeof SECURITY_AUDIT_SCOPE_KINDS)[number];

/** Las seis fases del flujo completo, en el orden oficial de SKILL.md. */
export const SECURITY_AUDIT_PHASES = [
  "reconnaissance",
  "coverage-hunting-waves",
  "candidate-validation",
  "structured-output",
  "independent-record-verification",
  "target-neutral-report",
] as const;
export type SecurityAuditPhase = (typeof SECURITY_AUDIT_PHASES)[number];

export const SECURITY_AUDIT_RUN_STATUSES = ["in_progress", "complete", "incomplete"] as const;
export type SecurityAuditRunStatus = (typeof SECURITY_AUDIT_RUN_STATUSES)[number];

/** Motivos oficiales de presupuesto de SKILL.md (sin pérdida ni fusión). */
export const SECURITY_AUDIT_BUDGET_INCOMPLETE_REASONS = [
  "budget_cannot_fund_reconnaissance_and_reserves",
  "budget_cannot_reserve_critics_and_validation",
  "critic_budget_exhausted",
  "validation_budget_exhausted",
] as const;

/**
 * Motivos operativos de cierre terminal: un run que no puede avanzar debe
 * quedar en un estado `incomplete` real (nunca `in_progress` eterno).
 * - `validator_failed`: un validador oficial rechazó un artefacto.
 * - `orchestrator_failed`: error interno del orquestador o siembra imposible.
 * - `provider_unavailable`: 429/timeout del proveedor (sin replay automático).
 * - `cancelled_by_user`: cancelación del operador.
 * - `deadline_exceeded`: `maxDurationMs` agotado.
 * - `execution_interrupted`: la ejecución asociada murió o fue interrumpida.
 */
export const SECURITY_AUDIT_OPERATIONAL_INCOMPLETE_REASONS = [
  "validator_failed",
  "orchestrator_failed",
  "provider_unavailable",
  "cancelled_by_user",
  "deadline_exceeded",
  "execution_interrupted",
] as const;

/** Únicos motivos admitidos en `run_status: "incomplete"`. */
export const SECURITY_AUDIT_INCOMPLETE_REASONS = [
  ...SECURITY_AUDIT_BUDGET_INCOMPLETE_REASONS,
  ...SECURITY_AUDIT_OPERATIONAL_INCOMPLETE_REASONS,
] as const;
export type SecurityAuditIncompleteReason = (typeof SECURITY_AUDIT_INCOMPLETE_REASONS)[number];

/**
 * Dominios oficiales = nombres de los documentos companion de la skill
 * (los que declaran `When to use this file`). Los identificadores son los
 * nombres de archivo sin extensión para que coincidan con las referencias
 * canónicas `FILE.md#sección` de RECONNAISSANCE.md.
 */
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
export type SecurityAuditDomain = (typeof SECURITY_AUDIT_DOMAINS)[number];

export type SecurityAuditValidation<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export function isSecurityAuditIntent(value: unknown): value is SecurityAuditIntent {
  return typeof value === "string" && (SECURITY_AUDIT_INTENTS as readonly string[]).includes(value);
}

export function isSecurityAuditProfile(value: unknown): value is SecurityAuditProfile {
  return typeof value === "string" && (SECURITY_AUDIT_PROFILES as readonly string[]).includes(value);
}

export function isSecurityAuditDomain(value: unknown): value is SecurityAuditDomain {
  return typeof value === "string" && (SECURITY_AUDIT_DOMAINS as readonly string[]).includes(value);
}

export function isSecurityAuditIncompleteReason(
  value: unknown,
): value is SecurityAuditIncompleteReason {
  return typeof value === "string"
    && (SECURITY_AUDIT_INCOMPLETE_REASONS as readonly string[]).includes(value);
}

/** Documento companion oficial de un dominio, o `null` si el dominio no es oficial. */
export function securityAuditDomainDocument(domain: string): string | null {
  return isSecurityAuditDomain(domain) ? `${domain}.md` : null;
}

export interface SecurityAuditScope {
  kind: SecurityAuditScopeKind;
  scopePaths: readonly string[];
  domains: readonly SecurityAuditDomain[];
  baseRef?: string;
  headRef?: string;
}

const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}]/u;

function invalidScopePath(path: string): string | null {
  if (path.length === 0) return "scope_paths no puede contener cadenas vacías";
  if (CONTROL_CHARACTERS.test(path)) return `scope_paths con caracteres de control: ${JSON.stringify(path)}`;
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) {
    return `scope_paths debe ser relativo al proyecto: ${JSON.stringify(path)}`;
  }
  const segments = path.split(/[\\/]+/);
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return `scope_paths con segmentos vacíos o de traversal: ${JSON.stringify(path)}`;
  }
  return null;
}

/**
 * Valida un alcance de auditoría. Reglas por tipo:
 * - `project`: sin paths, sin dominios ni refs;
 * - `directory` / `component`: `scope_paths` no vacío, sin dominios ni refs;
 * - `domain`: `domains` no vacío, sin paths ni refs;
 * - `git-diff`: `baseRef` y `headRef` obligatorios y distintos; `scope_paths`
 *   y `domains` opcionales para acotar el diff.
 */
export function validateSecurityAuditScope(
  input: unknown,
): SecurityAuditValidation<SecurityAuditScope> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: "el alcance debe ser un objeto" };
  }
  const candidate = input as Record<string, unknown>;
  const kind = candidate.kind;
  if (typeof kind !== "string" || !(SECURITY_AUDIT_SCOPE_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, error: `kind de alcance inválido: ${JSON.stringify(kind)}` };
  }

  const rawPaths = candidate.scopePaths ?? [];
  if (!Array.isArray(rawPaths)) return { ok: false, error: "scope_paths debe ser una lista" };
  const scopePaths: string[] = [];
  for (const raw of rawPaths) {
    if (typeof raw !== "string") return { ok: false, error: "scope_paths debe contener strings" };
    const problem = invalidScopePath(raw);
    if (problem) return { ok: false, error: problem };
    if (scopePaths.includes(raw)) return { ok: false, error: `scope_paths duplicado: ${JSON.stringify(raw)}` };
    scopePaths.push(raw);
  }

  const rawDomains = candidate.domains ?? [];
  if (!Array.isArray(rawDomains)) return { ok: false, error: "domains debe ser una lista" };
  const domains: SecurityAuditDomain[] = [];
  for (const raw of rawDomains) {
    if (!isSecurityAuditDomain(raw)) {
      return { ok: false, error: `dominio no oficial: ${JSON.stringify(raw)}` };
    }
    if (domains.includes(raw)) return { ok: false, error: `dominio duplicado: ${JSON.stringify(raw)}` };
    domains.push(raw);
  }

  const readRef = (field: "baseRef" | "headRef"): string | undefined => {
    const value = candidate[field];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string" || value.trim().length === 0) {
      return undefined; // señal de error explícita más abajo
    }
    if (CONTROL_CHARACTERS.test(value)) return undefined;
    return value;
  };
  const hasBaseField = candidate.baseRef !== undefined && candidate.baseRef !== null;
  const hasHeadField = candidate.headRef !== undefined && candidate.headRef !== null;
  const baseRef = readRef("baseRef");
  const headRef = readRef("headRef");
  if (hasBaseField && !baseRef) return { ok: false, error: "baseRef debe ser un string no vacío" };
  if (hasHeadField && !headRef) return { ok: false, error: "headRef debe ser un string no vacío" };

  if (kind === "project") {
    if (scopePaths.length > 0 || domains.length > 0 || baseRef || headRef) {
      return { ok: false, error: "project no admite scope_paths, domains ni refs" };
    }
  } else if (kind === "directory" || kind === "component") {
    if (scopePaths.length === 0) {
      return { ok: false, error: `${kind} exige al menos un scope_path` };
    }
    if (domains.length > 0 || baseRef || headRef) {
      return { ok: false, error: `${kind} no admite domains ni refs` };
    }
  } else if (kind === "domain") {
    if (domains.length === 0) {
      return { ok: false, error: "domain exige al menos un dominio oficial" };
    }
    if (scopePaths.length > 0 || baseRef || headRef) {
      return { ok: false, error: "domain no admite scope_paths ni refs" };
    }
  } else {
    if (!baseRef || !headRef) {
      return { ok: false, error: "git-diff exige baseRef y headRef" };
    }
    if (baseRef === headRef) {
      return { ok: false, error: "git-diff requiere baseRef distintos de headRef" };
    }
  }

  const scope: SecurityAuditScope = { kind: kind as SecurityAuditScopeKind, scopePaths, domains };
  if (baseRef) scope.baseRef = baseRef;
  if (headRef) scope.headRef = headRef;
  return { ok: true, value: scope };
}

export interface SecurityAuditRunState {
  status: SecurityAuditRunStatus;
  reason: SecurityAuditIncompleteReason | null;
}

export function createSecurityAuditRunState(): SecurityAuditRunState {
  return { status: "in_progress", reason: null };
}

export function completeSecurityAuditRun(
  state: SecurityAuditRunState,
): SecurityAuditValidation<SecurityAuditRunState> {
  if (state.status === "incomplete") {
    return { ok: false, error: "un run incompleto no puede pasar a complete" };
  }
  return { ok: true, value: { status: "complete", reason: null } };
}

export function markSecurityAuditRunIncomplete(
  reason: unknown,
): SecurityAuditValidation<SecurityAuditRunState> {
  if (!isSecurityAuditIncompleteReason(reason)) {
    return { ok: false, error: `motivo incomplete no oficial: ${JSON.stringify(reason)}` };
  }
  return { ok: true, value: { status: "incomplete", reason } };
}

export interface SecurityAuditIntentPlan {
  intent: SecurityAuditIntent;
  createsArtifacts: boolean;
  sixPhasePlan: boolean;
  phases: readonly SecurityAuditPhase[];
}

/**
 * Separación guidance / full_audit / remediation:
 * - `guidance`: ni artefactos ni plan de seis fases;
 * - `full_audit`: artefactos y las seis fases;
 * - `remediation`: tampoco usa el plan de seis fases; genera una solicitud
 *   independiente vía `createSecurityAuditRemediationRequest`.
 */
export function planForSecurityAuditIntent(intent: SecurityAuditIntent): SecurityAuditIntentPlan {
  if (intent === "full_audit") {
    return {
      intent,
      createsArtifacts: true,
      sixPhasePlan: true,
      phases: [...SECURITY_AUDIT_PHASES],
    };
  }
  return { intent, createsArtifacts: false, sixPhasePlan: false, phases: [] };
}

const SAFE_REQUEST_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface SecurityAuditRemediationRequest {
  kind: "remediation";
  requestId: string;
  targetRunId: string;
  fingerprints: readonly string[];
  /** Siempre `false`: la remediación nunca escribe sobre el target auditado. */
  modifiesAuditedTarget: false;
  /** Siempre `true`: es una solicitud propia, separada del run de auditoría. */
  independent: true;
}

/**
 * Crea la solicitud de remediación. Exige fingerprints (sin ellos no hay
 * hallazgos que corregir) y produce un objeto nuevo e independiente: la
 * función es pura y jamás recibe ni muta el estado del run en auditoría.
 */
export function createSecurityAuditRemediationRequest(input: {
  requestId: string;
  targetRunId: string;
  fingerprints: readonly string[];
}): SecurityAuditValidation<SecurityAuditRemediationRequest> {
  if (!SAFE_REQUEST_ID.test(input.requestId)) {
    return { ok: false, error: `requestId inválido: ${JSON.stringify(input.requestId)}` };
  }
  if (typeof input.targetRunId !== "string" || input.targetRunId.trim().length === 0) {
    return { ok: false, error: "targetRunId no puede estar vacío" };
  }
  if (!Array.isArray(input.fingerprints) || input.fingerprints.length === 0) {
    return { ok: false, error: "remediation exige al menos un fingerprint" };
  }
  const fingerprints: string[] = [];
  for (const fingerprint of input.fingerprints) {
    if (typeof fingerprint !== "string" || fingerprint.trim().length === 0) {
      return { ok: false, error: "fingerprint vacío" };
    }
    if (CONTROL_CHARACTERS.test(fingerprint)) {
      return { ok: false, error: `fingerprint con caracteres de control: ${JSON.stringify(fingerprint)}` };
    }
    if (fingerprints.includes(fingerprint)) {
      return { ok: false, error: `fingerprint duplicado: ${JSON.stringify(fingerprint)}` };
    }
    fingerprints.push(fingerprint);
  }
  return {
    ok: true,
    value: {
      kind: "remediation",
      requestId: input.requestId,
      targetRunId: input.targetRunId,
      fingerprints,
      modifiesAuditedTarget: false,
      independent: true,
    },
  };
}

export interface SecurityAuditBudgetConfig {
  /** Número máximo de invocaciones de agentes, o `null` sin tope. */
  maxInvocations: number | null;
  /** Entero >= 1: agentes en paralelo como máximo. */
  maxConcurrency: number;
  /** Duración máxima en ms (cancel/resume la gestiona el ledger de presupuesto). */
  maxDurationMs: number;
}

export function validateSecurityAuditBudgetConfig(
  input: unknown,
): SecurityAuditValidation<SecurityAuditBudgetConfig> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: "el presupuesto debe ser un objeto" };
  }
  const candidate = input as Record<string, unknown>;
  const { maxInvocations, maxConcurrency, maxDurationMs } = candidate;
  if (maxInvocations !== null) {
    if (typeof maxInvocations !== "number" || !Number.isInteger(maxInvocations) || maxInvocations < 1) {
      return { ok: false, error: "maxInvocations debe ser null o un entero >= 1" };
    }
  }
  if (typeof maxConcurrency !== "number" || !Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    return { ok: false, error: "maxConcurrency debe ser un entero >= 1" };
  }
  if (typeof maxDurationMs !== "number" || !Number.isInteger(maxDurationMs) || maxDurationMs < 1) {
    return { ok: false, error: "maxDurationMs debe ser un entero >= 1" };
  }
  return {
    ok: true,
    value: {
      maxInvocations: maxInvocations as number | null,
      maxConcurrency,
      maxDurationMs,
    },
  };
}

export interface SecurityAuditVerificationStrategy {
  candidateValidation: "fresh-agent-per-candidate";
  finalRecordVerification: "fresh-agent-per-candidate" | "same-fresh-verifier-as-candidate-validation";
  /** `quick` reutiliza un verificador fresco; `standard`/`deep` separan fases 3 y 5. */
  separatePhase3AndPhase5: boolean;
  hunterWaveLimit: number | null;
}

export function verificationStrategyFor(
  profile: SecurityAuditProfile,
): SecurityAuditVerificationStrategy {
  if (profile === "quick") {
    return {
      candidateValidation: "fresh-agent-per-candidate",
      finalRecordVerification: "same-fresh-verifier-as-candidate-validation",
      separatePhase3AndPhase5: false,
      hunterWaveLimit: 1,
    };
  }
  return {
    candidateValidation: "fresh-agent-per-candidate",
    finalRecordVerification: "fresh-agent-per-candidate",
    separatePhase3AndPhase5: true,
    hunterWaveLimit: null,
  };
}

export type SecurityAuditProviderErrorKind =
  | "rate_limited"
  | "auth"
  | "timeout"
  | "server_error"
  | "invalid_request"
  | "unknown";

export interface SecurityAuditProviderErrorClassification {
  status: number | null;
  kind: SecurityAuditProviderErrorKind;
  retryable: boolean;
  /**
   * Siempre `false`: un error de proveedor nunca reenvía prompts
   * automáticamente. La reanudación es decisión de la capa de orquestación.
   */
  autoReplay: false;
}

function statusFrom(input: unknown): number | null {
  if (typeof input === "number" && Number.isInteger(input)) return input;
  if (typeof input === "object" && input !== null) {
    const candidate = input as Record<string, unknown>;
    for (const field of ["status", "statusCode", "httpStatus"]) {
      const value = candidate[field];
      if (typeof value === "number" && Number.isInteger(value)) return value;
    }
    const code = candidate.code;
    if (code === "ETIMEDOUT" || code === "ECONNRESET") return 408;
    if (code === "E429") return 429;
  }
  return null;
}

/**
 * Clasifica errores de proveedor sin reintentos automáticos: un 429 es
 * `rate_limited` y reintentable, pero `autoReplay` queda en `false` para que
 * ningún prompt se reenvíe sin decisión explícita.
 */
export function classifySecurityAuditProviderError(
  input: unknown,
): SecurityAuditProviderErrorClassification {
  const status = statusFrom(input);
  let kind: SecurityAuditProviderErrorKind = "unknown";
  if (status === 429) kind = "rate_limited";
  else if (status === 401 || status === 403) kind = "auth";
  else if (status === 408 || status === 504) kind = "timeout";
  else if (status !== null && status >= 500) kind = "server_error";
  else if (status !== null && status >= 400 && status < 500) kind = "invalid_request";
  const retryable = kind === "rate_limited" || kind === "timeout" || kind === "server_error";
  return { status, kind, retryable, autoReplay: false };
}

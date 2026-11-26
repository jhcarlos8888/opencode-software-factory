/**
 * Opciones explícitas de la modalidad `securityAudit` para `startExecution`.
 *
 * Se validan con los contratos de la ola 1 (`security-audit-contracts`) antes
 * de crear cualquier registro: scope oficial, presupuesto con enteros
 * correctos, política de ejecución conocida y `resumeRunId` solo cuando se
 * solicita reanudación. Guidance nunca llega aquí (la intención implícita de
 * esta modalidad es `full_audit`).
 *
 * F10: `sourceRef`/`sourceDirty` del cliente NO se aceptan (error
 * `client_source_not_authoritative`): la procedencia la resuelve el servidor
 * con `security-audit-source` y nunca se hereda una identidad declarada.
 */

import {
  validateSecurityAuditBudgetConfig,
  validateSecurityAuditScope,
  type SecurityAuditProfile,
  type SecurityAuditScope,
} from "./security-audit-contracts.js";

export interface SecurityAuditExecutionOptions {
  profile?: unknown;
  scope?: unknown;
  budget?: unknown;
  /**
   * DEPRECADO: `sourceRef`/`sourceDirty` aportados por la API/cliente se
   * RECHAZAN con `client_source_not_authoritative`. La procedencia del origen
   * la resuelve SIEMPRE el servidor (`security-audit-source`).
   */
  sourceRef?: unknown;
  sourceDirty?: unknown;
  resumeRunId?: unknown;
  executionPolicy?: unknown;
  sandboxAuthorization?: unknown;
}

export interface ResolvedSecurityAuditStart {
  profile: SecurityAuditProfile;
  scope: SecurityAuditScope;
  budget: { maxInvocations: number | null; maxConcurrency: number; maxDurationMs: number };
  resumeRunId: string | null;
  executionPolicy: "source-only" | "sandboxed-source-and-local-only";
  sandboxAuthorization: unknown;
}

export class SecurityAuditStartOptionsError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "SecurityAuditStartOptionsError";
  }
}

const DEFAULT_BUDGET = {
  maxInvocations: null,
  maxConcurrency: 1,
  maxDurationMs: 3_600_000,
} as const;

const EXECUTION_POLICIES = ["source-only", "sandboxed-source-and-local-only"] as const;

/** Valida y normaliza `StartExecutionOptions.securityAudit`. */
export function validateSecurityAuditStartOptions(
  options: unknown,
): ResolvedSecurityAuditStart {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new SecurityAuditStartOptionsError(
      "invalid_options",
      "securityAudit debe ser un objeto con profile y scope explícitos.",
    );
  }
  const input = options as SecurityAuditExecutionOptions;

  if (input.profile !== "quick" && input.profile !== "standard" && input.profile !== "deep") {
    throw new SecurityAuditStartOptionsError(
      "invalid_profile",
      "securityAudit.profile debe ser quick, standard o deep.",
    );
  }

  const scope = validateSecurityAuditScope(input.scope);
  if (!scope.ok) {
    throw new SecurityAuditStartOptionsError("invalid_scope", scope.error);
  }

  const budgetInput = input.budget ?? DEFAULT_BUDGET;
  const budget = validateSecurityAuditBudgetConfig(budgetInput);
  if (!budget.ok) {
    throw new SecurityAuditStartOptionsError("invalid_budget", budget.error);
  }

  // F10: la procedencia del origen es del SERVIDOR. sourceRef/sourceDirty
  // aportados por la API/cliente se rechazan SIEMPRE: nunca se acepta una
  // identidad de origen declarada (el orquestador la resuelve con git real).
  if (input.sourceRef !== undefined) {
    throw new SecurityAuditStartOptionsError(
      "client_source_not_authoritative",
      "client_source_not_authoritative: securityAudit.sourceRef no es aceptado; el servidor resuelve la referencia de origen real del target.",
    );
  }
  if (input.sourceDirty !== undefined) {
    throw new SecurityAuditStartOptionsError(
      "client_source_not_authoritative",
      "client_source_not_authoritative: securityAudit.sourceDirty no es aceptado; el servidor resuelve el estado dirty real del target.",
    );
  }
  if (input.resumeRunId !== undefined && input.resumeRunId !== null &&
      typeof input.resumeRunId !== "string") {
    throw new SecurityAuditStartOptionsError(
      "invalid_resume",
      "securityAudit.resumeRunId debe ser string o null (reanudación explícita).",
    );
  }

  const executionPolicy = input.executionPolicy ?? "source-only";
  if (!(EXECUTION_POLICIES as readonly unknown[]).includes(executionPolicy)) {
    throw new SecurityAuditStartOptionsError(
      "invalid_execution_policy",
      "securityAudit.executionPolicy debe ser source-only o sandboxed-source-and-local-only.",
    );
  }
  // F08: la ejecución sandboxed NO está implementada. Se rechaza SIEMPRE,
  // aunque venga con una autorización sandbox válida: error explícito
  // `sandbox_not_implemented`, sin fallback silencioso a source-only y sin
  // metadata sandboxed. El módulo `security-audit-sandbox` queda como
  // limitación documentada, sin llamador productivo.
  if (executionPolicy === "sandboxed-source-and-local-only") {
    throw new SecurityAuditStartOptionsError(
      "sandbox_not_implemented",
      "sandbox_not_implemented: la política sandboxed-source-and-local-only no está implementada; securityAudit solo acepta executionPolicy source-only (ninguna autorización sandbox la habilita).",
    );
  }

  return {
    profile: input.profile,
    scope: scope.value,
    budget: {
      maxInvocations: budget.value.maxInvocations,
      maxConcurrency: budget.value.maxConcurrency,
      maxDurationMs: budget.value.maxDurationMs,
    },
    resumeRunId: typeof input.resumeRunId === "string" ? input.resumeRunId : null,
    executionPolicy: executionPolicy as ResolvedSecurityAuditStart["executionPolicy"],
    // F08: source-only no lleva autorización sandbox; nunca se propaga
    // metadata sandboxed hacia el orquestador ni hacia run-metadata.json.
    sandboxAuthorization: null,
  };
}

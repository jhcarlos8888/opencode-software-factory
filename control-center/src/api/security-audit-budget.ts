/**
 * Presupuesto oficial de invocaciones para un run `security-audit`
 * (SKILL.md § Cost budget). Funciones puras: ninguna lee el reloj ni la red.
 *
 * Gate pre-reconocimiento: 4 llamadas baseline de recon + críticos
 * (`quick` 1; `standard`/`deep` 2 = crítico post-ola + crítico final limpio)
 * + al menos 1 verificador ⇒ mínimo `quick` 6 y `standard`/`deep` 7.
 *
 * Las reservas se crean ANTES de cualquier hunter; con duda sobre el número de
 * candidatos se reserva un 30% del balance tras reservar críticos. Nunca se
 * gasta una reserva para cazar, nunca se supera `maxInvocations` y
 * `maxConcurrency` es siempre un entero >= 1.
 *
 * Motivos oficiales (`SecurityAuditIncompleteReason`) = los cuatro que
 * `SKILL.md` permite en `run_status: "incomplete"`. Los demás motivos de esta
 * función (`quick_profile_single_wave`, `reconnaissance_not_completed`,
 * `run_cancelled`, `max_duration_exhausted`, `hunt_budget_exhausted`) son
 * rechazos de puerta/evidencia de ledger y JAMÁS se usan como
 * `incomplete_reason`.
 */

import {
  validateSecurityAuditBudgetConfig,
  type SecurityAuditIncompleteReason,
  type SecurityAuditProfile,
} from "./security-audit-contracts.js";

export const SECURITY_AUDIT_RECON_BASELINE = 4;

export type SecurityAuditSpendCategory = "recon" | "hunters" | "critics" | "verifiers";

export type SecurityAuditBudgetState = "active" | "cancelled" | "expired";

export interface SecurityAuditBudgetReserves {
  recon: number;
  critics: number;
  validation: number;
}

export interface SecurityAuditBudgetSpent {
  recon: number;
  hunters: number;
  critics: number;
  verifiers: number;
}

export type SecurityAuditDeferredReason =
  | SecurityAuditIncompleteReason
  | "hunt_budget_exhausted";

export interface SecurityAuditDeferredUnit {
  unitId: string;
  reason: SecurityAuditDeferredReason;
}

export type SecurityAuditGateReason =
  | SecurityAuditIncompleteReason
  | "quick_profile_single_wave"
  | "reconnaissance_not_completed"
  | "run_cancelled"
  | "max_duration_exhausted"
  | "hunt_budget_exhausted";

export interface SecurityAuditBudgetLedger {
  readonly profile: SecurityAuditProfile;
  readonly maxInvocations: number | null;
  readonly maxConcurrency: number;
  readonly maxDurationMs: number;
  readonly reserved: SecurityAuditBudgetReserves;
  readonly spent: SecurityAuditBudgetSpent;
  /** Unidades planificadas aún sin asignar a un hunter. */
  readonly pendingUnits: number;
  readonly wavesStarted: number;
  readonly state: SecurityAuditBudgetState;
  readonly deferredUnits: readonly SecurityAuditDeferredUnit[];
  readonly unvalidatedFingerprints: readonly string[];
}

export type SecurityAuditBudgetResult =
  | { ok: true; ledger: SecurityAuditBudgetLedger }
  | {
      ok: false;
      reason: SecurityAuditGateReason;
      /** Unidades que la puerta impidió lanzar en esta ola. */
      unitIds?: readonly string[];
      /** Candidatos que no pudieron validarse por falta de presupuesto. */
      unvalidatedFingerprints?: readonly string[];
    };

export type SecurityAuditBudgetCreateResult =
  | { ok: true; ledger: SecurityAuditBudgetLedger }
  | { ok: false; reason: "budget_cannot_fund_reconnaissance_and_reserves" };

export type SecurityAuditWaveResult =
  | {
      ok: true;
      ledger: SecurityAuditBudgetLedger;
      wave: number;
      launched: number;
      deferred: readonly SecurityAuditDeferredUnit[];
    }
  | { ok: false; reason: SecurityAuditGateReason; unitIds: readonly string[] };

export class SecurityAuditBudgetConfigError extends Error {
  override readonly name = "SecurityAuditBudgetConfigError";
}

export interface SecurityAuditBudgetInput {
  profile: SecurityAuditProfile;
  maxInvocations: number | null;
  maxConcurrency: number;
  maxDurationMs: number;
  /** Unidades planificadas para el run (evidencia de pendientes). */
  pendingUnits?: number;
  /** Candidatos esperados; con duda usa `inDoubt`. */
  expectedCandidates?: number;
  inDoubt?: boolean;
}

/** Críticos obligatorios: `quick` 1 (final); `standard`/`deep` 2 (post-ola + final limpio). */
export function criticReserveFor(profile: SecurityAuditProfile): number {
  return profile === "quick" ? 1 : 2;
}

/** Mínimo oficial: 4 recon + críticos + al menos 1 verificador (6 ó 7). */
export function minimumSecurityAuditBudget(profile: SecurityAuditProfile): number {
  return SECURITY_AUDIT_RECON_BASELINE + criticReserveFor(profile) + 1;
}

function validatorsPerCandidate(profile: SecurityAuditProfile): number {
  // `standard`/`deep` mantienen fases 3 y 5 con agentes frescos distintos.
  return profile === "quick" ? 1 : 2;
}

function requireInteger(value: unknown, field: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) {
    throw new SecurityAuditBudgetConfigError(`${field} debe ser un entero >= ${minimum}`);
  }
  return value;
}

/**
 * Crea el ledger con las reservas ya hechas. Rechaza con
 * `budget_cannot_fund_reconnaissance_and_reserves` si el presupuesto pedido no
 * financia recon + críticos + reserva de validación (o el mínimo oficial).
 */
export function createSecurityAuditBudget(
  input: SecurityAuditBudgetInput,
): SecurityAuditBudgetCreateResult {
  const config = validateSecurityAuditBudgetConfig({
    maxInvocations: input.maxInvocations,
    maxConcurrency: input.maxConcurrency,
    maxDurationMs: input.maxDurationMs,
  });
  if (!config.ok) throw new SecurityAuditBudgetConfigError(config.error);
  const pendingUnits = input.pendingUnits === undefined
    ? 0
    : requireInteger(input.pendingUnits, "pendingUnits", 0);
  if (input.expectedCandidates !== undefined) {
    requireInteger(input.expectedCandidates, "expectedCandidates", 1);
  }
  if (!["quick", "standard", "deep"].includes(input.profile)) {
    throw new SecurityAuditBudgetConfigError(`profile inválido: ${JSON.stringify(input.profile)}`);
  }

  const critics = criticReserveFor(input.profile);
  const perCandidate = validatorsPerCandidate(input.profile);
  const expected = input.expectedCandidates;
  let validation: number;

  if (config.value.maxInvocations === null) {
    // Sin tope no hay gate: la reserva es documental.
    validation = expected === undefined ? 1 : Math.max(1, perCandidate * expected);
  } else {
    const max = config.value.maxInvocations;
    const minimum = minimumSecurityAuditBudget(input.profile);
    if (max < minimum) {
      return { ok: false, reason: "budget_cannot_fund_reconnaissance_and_reserves" };
    }
    const balanceAfterCritics = max - SECURITY_AUDIT_RECON_BASELINE - critics;
    validation = input.inDoubt === true
      ? Math.max(1, Math.ceil(balanceAfterCritics * 0.3))
      : expected === undefined ? 1 : Math.max(1, perCandidate * expected);
    if (SECURITY_AUDIT_RECON_BASELINE + critics + validation > max) {
      return { ok: false, reason: "budget_cannot_fund_reconnaissance_and_reserves" };
    }
  }

  return {
    ok: true,
    ledger: {
      profile: input.profile,
      maxInvocations: config.value.maxInvocations,
      maxConcurrency: config.value.maxConcurrency,
      maxDurationMs: config.value.maxDurationMs,
      reserved: {
        recon: SECURITY_AUDIT_RECON_BASELINE,
        critics,
        validation,
      },
      spent: { recon: 0, hunters: 0, critics: 0, verifiers: 0 },
      pendingUnits,
      wavesStarted: 0,
      state: "active",
      deferredUnits: [],
      unvalidatedFingerprints: [],
    },
  };
}

/**
 * Reconstruye un ledger de presupuesto a partir de la evidencia persistida
 * (para reanudación). Valida las formas y respeta el tope: nunca restaura un
 * gasto que exceda `maxInvocations`.
 */
export function restoreSecurityAuditBudget(
  input: SecurityAuditBudgetInput,
  spent: SecurityAuditBudgetSpent,
  reserved: SecurityAuditBudgetReserves,
  options: {
    pendingUnits?: number;
    deferredUnits?: readonly SecurityAuditDeferredUnit[];
    unvalidatedFingerprints?: readonly string[];
    wavesStarted?: number;
  } = {},
): SecurityAuditBudgetLedger {
  const created = createSecurityAuditBudget(input);
  if (!created.ok) {
    throw new SecurityAuditBudgetConfigError(
      "no se puede restaurar un presupuesto que no supera el gate mínimo",
    );
  }
  const counter = (value: number | undefined, field: string): number => {
    if (value === undefined) return 0;
    return requireInteger(value, field, 0);
  };
  const ledger: SecurityAuditBudgetLedger = {
    ...created.ledger,
    spent: {
      recon: counter(spent.recon, "spent.recon"),
      hunters: counter(spent.hunters, "spent.hunters"),
      critics: counter(spent.critics, "spent.critics"),
      verifiers: counter(spent.verifiers, "spent.verifiers"),
    },
    reserved: {
      recon: counter(reserved.recon, "reserved.recon"),
      critics: counter(reserved.critics, "reserved.critics"),
      validation: counter(reserved.validation, "reserved.validation"),
    },
    pendingUnits: options.pendingUnits ?? created.ledger.pendingUnits,
    wavesStarted: options.wavesStarted ?? 0,
    deferredUnits: [...(options.deferredUnits ?? [])],
    unvalidatedFingerprints: [...(options.unvalidatedFingerprints ?? [])],
  };
  if (securityAuditBudgetOverLimit(ledger)) {
    throw new SecurityAuditBudgetConfigError(
      "la evidencia restaurada excede maxInvocations",
    );
  }
  return ledger;
}

function totalFor(ledger: SecurityAuditBudgetLedger): number {
  return ledger.maxInvocations === null ? Number.POSITIVE_INFINITY : ledger.maxInvocations;
}

function spentTotal(ledger: SecurityAuditBudgetLedger): number {
  const { recon, hunters, critics, verifiers } = ledger.spent;
  return recon + hunters + critics + verifiers;
}

function reservedTotal(ledger: SecurityAuditBudgetLedger): number {
  const { recon, critics, validation } = ledger.reserved;
  return recon + critics + validation;
}

/** Unidades todavía gastables fuera de las reservas (Infinity si no hay tope). */
export function freeSecurityAuditUnits(ledger: SecurityAuditBudgetLedger): number {
  return Math.max(0, totalFor(ledger) - spentTotal(ledger) - reservedTotal(ledger));
}

/** Invariante «nunca exceder max»: `true` si el ledger se pasa del tope. */
export function securityAuditBudgetOverLimit(ledger: SecurityAuditBudgetLedger): boolean {
  if (ledger.maxInvocations === null) return false;
  return spentTotal(ledger) + reservedTotal(ledger) > ledger.maxInvocations;
}

function stateGateReason(ledger: SecurityAuditBudgetLedger): SecurityAuditGateReason | null {
  if (ledger.state === "cancelled") return "run_cancelled";
  if (ledger.state === "expired") return "max_duration_exhausted";
  return null;
}

function reserveKeyFor(
  category: SecurityAuditSpendCategory,
): keyof SecurityAuditBudgetReserves | null {
  if (category === "recon") return "recon";
  if (category === "critics") return "critics";
  if (category === "verifiers") return "validation";
  return null;
}

function exhaustionReason(category: SecurityAuditSpendCategory): SecurityAuditGateReason {
  if (category === "recon") return "budget_cannot_fund_reconnaissance_and_reserves";
  if (category === "critics") return "critic_budget_exhausted";
  if (category === "verifiers") return "validation_budget_exhausted";
  return "hunt_budget_exhausted";
}

function spendCategory(
  ledger: SecurityAuditBudgetLedger,
  category: SecurityAuditSpendCategory,
  amount: number,
): SecurityAuditBudgetResult {
  requireInteger(amount, "amount", 1);
  const blocked = stateGateReason(ledger);
  if (blocked) return { ok: false, reason: blocked };

  const key = reserveKeyFor(category);
  const poolAvailable = key === null ? 0 : ledger.reserved[key];
  const fromPool = Math.min(amount, poolAvailable);
  const rest = amount - fromPool;
  if (rest > freeSecurityAuditUnits(ledger)) {
    return { ok: false, reason: exhaustionReason(category) };
  }

  const reserved: SecurityAuditBudgetReserves = { ...ledger.reserved };
  if (key !== null) reserved[key] = poolAvailable - fromPool;
  const spent: SecurityAuditBudgetSpent = {
    recon: ledger.spent.recon + (category === "recon" ? amount : 0),
    hunters: ledger.spent.hunters + (category === "hunters" ? amount : 0),
    critics: ledger.spent.critics + (category === "critics" ? amount : 0),
    verifiers: ledger.spent.verifiers + (category === "verifiers" ? amount : 0),
  };
  const next: SecurityAuditBudgetLedger = { ...ledger, reserved, spent };
  if (securityAuditBudgetOverLimit(next)) {
    // Defensa en profundidad: jamás publicar un ledger fuera del tope.
    throw new SecurityAuditBudgetConfigError("el gasto excedería maxInvocations");
  }
  return { ok: true, ledger: next };
}

/** Gasta llamadas de recon (primero la reserva baseline de 4). */
export function spendSecurityAuditRecon(
  ledger: SecurityAuditBudgetLedger,
  amount = 1,
): SecurityAuditBudgetResult {
  return spendCategory(ledger, "recon", amount);
}

/** Gasta críticos (primero la reserva de críticos). */
export function spendSecurityAuditCritic(
  ledger: SecurityAuditBudgetLedger,
  amount = 1,
): SecurityAuditBudgetResult {
  return spendCategory(ledger, "critics", amount);
}

/**
 * Gasta verificadores (primero la reserva de validación). Con
 * `validation_budget_exhausted` devuelve además los fingerprints sin validar:
 * no se reclasifican como `needs_validation` ni entran en `findings.json`.
 */
export function spendSecurityAuditVerifier(
  ledger: SecurityAuditBudgetLedger,
  input: { amount?: number; fingerprints?: readonly string[] } = {},
): SecurityAuditBudgetResult {
  const amount = input.amount ?? 1;
  const result = spendCategory(ledger, "verifiers", amount);
  if (!result.ok && input.fingerprints !== undefined && input.fingerprints.length > 0) {
    return { ...result, unvalidatedFingerprints: [...input.fingerprints] };
  }
  return result;
}

/**
 * Reserva el crítico de la ola y lanza hunters con lo que quede libre.
 *
 * - `quick`: exactamente una ola; una segunda se rechaza con
 *   `quick_profile_single_wave`.
 * - `standard`/`deep`: la ola 1 usa ya reservados; cada ola posterior debe
 *   reservar de nuevo su crítico post-ola o se rechaza con
 *   `budget_cannot_reserve_critics_and_validation`.
 * - La reserva de validación y el crítico final nunca se tocan.
 * - Caza solo tras completar las 4 llamadas baseline de recon.
 */
export function planSecurityAuditHuntWave(
  ledger: SecurityAuditBudgetLedger,
  unitIds: readonly string[],
): SecurityAuditWaveResult {
  if (!Array.isArray(unitIds) || unitIds.some((id) => typeof id !== "string" || id.length === 0)) {
    throw new SecurityAuditBudgetConfigError("unitIds debe ser una lista de strings no vacíos");
  }
  const blocked = stateGateReason(ledger);
  if (blocked) return { ok: false, reason: blocked, unitIds };
  if (ledger.reserved.recon > 0) {
    return { ok: false, reason: "reconnaissance_not_completed", unitIds };
  }
  if (ledger.profile === "quick" && ledger.wavesStarted >= 1) {
    return { ok: false, reason: "quick_profile_single_wave", unitIds };
  }

  let reserved: SecurityAuditBudgetReserves = { ...ledger.reserved };
  if (ledger.wavesStarted >= 1) {
    // Ola posterior en standard/deep: reservar ANTES su crítico post-ola.
    if (freeSecurityAuditUnits(ledger) < 1) {
      return { ok: false, reason: "budget_cannot_reserve_critics_and_validation", unitIds };
    }
    reserved = { ...reserved, critics: reserved.critics + 1 };
  }
  const provisional: SecurityAuditBudgetLedger = { ...ledger, reserved };
  const launch = Math.max(0, Math.min(unitIds.length, Math.floor(freeSecurityAuditUnits(provisional))));
  const deferred: SecurityAuditDeferredUnit[] = unitIds
    .slice(launch)
    .map((unitId) => ({ unitId, reason: "hunt_budget_exhausted" as const }));

  const spent: SecurityAuditBudgetSpent = {
    ...provisional.spent,
    hunters: provisional.spent.hunters + launch,
  };
  const next: SecurityAuditBudgetLedger = {
    ...provisional,
    spent,
    pendingUnits: Math.max(0, provisional.pendingUnits - unitIds.length),
    wavesStarted: provisional.wavesStarted + 1,
    deferredUnits: [...provisional.deferredUnits, ...deferred],
  };
  if (securityAuditBudgetOverLimit(next)) {
    throw new SecurityAuditBudgetConfigError("el gasto excedería maxInvocations");
  }
  return {
    ok: true,
    ledger: next,
    wave: next.wavesStarted,
    launched: launch,
    deferred,
  };
}

/**
 * Devuelve caza reservada por una ola que nunca llegó a invocarse (p. ej.
 * vencimiento del presupuesto de duración entre invocaciones de la ola): el
 * gasto publicado debe reflejar SOLO invocaciones realmente lanzadas. Es una
 * corrección pura decreciente: devolver jamás puede exceder `maxInvocations`.
 */
export function refundSecurityAuditHunters(
  ledger: SecurityAuditBudgetLedger,
  amount: number,
): SecurityAuditBudgetLedger {
  requireInteger(amount, "amount", 0);
  if (amount === 0 || ledger.spent.hunters === 0) return ledger;
  const hunters = Math.max(0, ledger.spent.hunters - amount);
  return { ...ledger, spent: { ...ledger.spent, hunters } };
}

/**
 * Slots simultáneos disponibles ahora mismo para una categoría: nunca supera
 * `maxConcurrency` ni lo que la reserva + saldo permite gastar en esa
 * categoría. Devuelve 0 si el run está cancelado o expirado.
 */
export function availableSecurityAuditParallelism(
  ledger: SecurityAuditBudgetLedger,
  category: SecurityAuditSpendCategory,
): number {
  if (ledger.state !== "active") return 0;
  const key = reserveKeyFor(category);
  const pool = key === null ? 0 : ledger.reserved[key];
  const spendable = freeSecurityAuditUnits(ledger) + pool;
  return Math.min(ledger.maxConcurrency, Math.max(0, Math.floor(spendable)));
}

/** Cancela el run (los gastos quedan bloqueados hasta `resume`). */
export function cancelSecurityAuditBudget(ledger: SecurityAuditBudgetLedger): SecurityAuditBudgetLedger {
  if (ledger.state === "expired") return ledger;
  return { ...ledger, state: "cancelled" };
}

/** Reanuda un run cancelado; un run expirado por duración no se reanuda. */
export function resumeSecurityAuditBudget(ledger: SecurityAuditBudgetLedger): SecurityAuditBudgetResult {
  if (ledger.state === "expired") return { ok: false, reason: "max_duration_exhausted" };
  if (ledger.state === "cancelled") return { ok: true, ledger: { ...ledger, state: "active" } };
  return { ok: true, ledger };
}

/** Marca expirado si el tiempo transcurrido supera `maxDurationMs`. */
export function tickSecurityAuditBudget(
  ledger: SecurityAuditBudgetLedger,
  elapsedMs: number,
): SecurityAuditBudgetLedger {
  if (typeof elapsedMs !== "number" || Number.isNaN(elapsedMs) || elapsedMs < 0) {
    throw new SecurityAuditBudgetConfigError("elapsedMs debe ser un número >= 0");
  }
  if (ledger.state === "active" && elapsedMs > ledger.maxDurationMs) {
    return { ...ledger, state: "expired" };
  }
  return ledger;
}

export interface SecurityAuditBudgetEvidence {
  profile: SecurityAuditProfile;
  state: SecurityAuditBudgetState;
  maxInvocations: number | null;
  maxConcurrency: number;
  maxDurationMs: number;
  reserved: SecurityAuditBudgetReserves;
  spent: SecurityAuditBudgetSpent;
  /** `null` cuando no hay tope de invocaciones. */
  free: number | null;
  pendingUnits: number;
  wavesStarted: number;
  deferredUnits: readonly SecurityAuditDeferredUnit[];
  unvalidatedFingerprints: readonly string[];
  concurrency: Record<SecurityAuditSpendCategory, number>;
}

/** Evidencia pura de reservas, gastos, unidades pendientes y concurrencia. */
export function securityAuditBudgetEvidence(
  ledger: SecurityAuditBudgetLedger,
): SecurityAuditBudgetEvidence {
  const free = freeSecurityAuditUnits(ledger);
  return {
    profile: ledger.profile,
    state: ledger.state,
    maxInvocations: ledger.maxInvocations,
    maxConcurrency: ledger.maxConcurrency,
    maxDurationMs: ledger.maxDurationMs,
    reserved: { ...ledger.reserved },
    spent: { ...ledger.spent },
    free: Number.isFinite(free) ? free : null,
    pendingUnits: ledger.pendingUnits,
    wavesStarted: ledger.wavesStarted,
    deferredUnits: [...ledger.deferredUnits],
    unvalidatedFingerprints: [...ledger.unvalidatedFingerprints],
    concurrency: {
      recon: availableSecurityAuditParallelism(ledger, "recon"),
      hunters: availableSecurityAuditParallelism(ledger, "hunters"),
      critics: availableSecurityAuditParallelism(ledger, "critics"),
      verifiers: availableSecurityAuditParallelism(ledger, "verifiers"),
    },
  };
}

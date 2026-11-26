/**
 * Paquete 6: estado REAL por fase de un run `security-audit`.
 *
 * Recorrer las seis fases NO equivale a completarlas: una corrida puede haber
 * pasado por todas y seguir dejando candidatos sin validar o cobertura
 * pendiente. Esta función pura traduce el estado objetivo del run (fases con
 * checkpoint completo, huecos y motivos oficiales) en un desglose honesto por
 * fase, sin llamadas a ningún modelo ni acceso a la base.
 *
 * Reglas:
 * - Una fase sin checkpoint completo → `pending`.
 * - Perfil `quick`: la fase 5 es `not_applicable` (fusión 3/5 del perfil),
 *   aunque el checkpoint exista.
 * - Fase 3 → `partial` con candidatos sin validar o unidades candidatas
 *   pendientes; `blocked` cuando además el motivo oficial indica presupuesto
 *   de validación agotado.
 * - Fase 2 → `partial` con unidades de cobertura pendientes; `completed` si no.
 * - Fases 4 y 6 → `completed` solo con checkpoint completo (un validador
 *   oficial que rechaza aborta la fase, por lo que un checkpoint completo
 *   implica validadores en PASS; si el motivo `validator_failed` aparece igualmente,
 *   la fase se declara `blocked`).
 * - Fase 1 → `completed` con checkpoint completo.
 */

export type SecurityAuditPhaseState =
  | "completed"
  | "partial"
  | "blocked"
  | "not_applicable"
  | "pending";

export interface SecurityAuditPhaseReport {
  phase: number;
  label: string;
  state: SecurityAuditPhaseState;
  /** Explicación en una frase; `null` cuando la fase está completa sin matices. */
  reason: string | null;
}

export interface SecurityAuditPhaseStatusInput {
  profile: "quick" | "standard" | "deep";
  /** Fases 1..6 con checkpoint completo. */
  phasesComplete: readonly number[];
  /** Fingerprints de candidatos sin verificación independiente. */
  unvalidatedCandidates: readonly string[];
  /**
   * Unidades planificadas/candidatas/bloqueadas/en curso sin cerrar (forma
   * combinada histórica). Si NO llegan los contadores separados, se usa como
   * antes para las fases 2 y 3 (compatibilidad).
   */
  pendingUnits: readonly string[];
  /**
   * Unidades pendientes de CAZA (`planned`|`in_progress`|`blocked`). Si llega,
   * la fase 2 solo es `partial` con unidades de cobertura reales: NUNCA por
   * candidatos pendientes de fase 3.
   */
  pendingCoverageUnits?: number;
  /** Unidades `candidate` pendientes de validación (fase 3). */
  pendingCandidateUnits?: number;
  /** Motivos oficiales del run (incluye el primario). */
  incompleteReasons: readonly string[];
  /** Unidades alias consolidadas bajo una canónica. */
  consolidatedUnits: number;
}

/** Etiquetas oficiales de las seis fases (mismas que la UI). */
const PHASE_LABELS: Record<number, string> = {
  1: "Reconocimiento",
  2: "Olas de caza",
  3: "Validación de candidatos",
  4: "Salida estructurada",
  5: "Verificación de registros",
  6: "Informe objetivo",
};

function cleanList(values: readonly string[]): Set<string> {
  return new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0));
}

/**
 * Desglose determinista del estado real de cada fase. Nunca describe una fase
 * parcial como "completada": el estado y el motivo lo dejan explícito.
 */
export function computeSecurityAuditPhaseStates(
  input: SecurityAuditPhaseStatusInput,
): SecurityAuditPhaseReport[] {
  const complete = new Set(input.phasesComplete);
  const unvalidated = cleanList(input.unvalidatedCandidates);
  const pending = cleanList(input.pendingUnits);
  const reasons = cleanList(input.incompleteReasons);
  const validationBudgetExhausted = reasons.has("validation_budget_exhausted");
  const validatorFailed = reasons.has("validator_failed");
  // Defecto 3: con contadores separados, la fase 2 solo responde a cobertura
  // pendiente (la caza terminó aunque queden candidatos); sin ellos, se
  // conserva el comportamiento anterior (lista combinada) por compatibilidad.
  const coveragePending = input.pendingCoverageUnits ?? pending.size;
  const candidateUnitsPending = input.pendingCandidateUnits ?? pending.size;

  const reports: SecurityAuditPhaseReport[] = [];
  for (let phase = 1; phase <= 6; phase += 1) {
    const label = PHASE_LABELS[phase] ?? `Fase ${phase}`;
    // Perfil quick: la fase 5 corre fusionada con la fase 3; declararla
    // pendiente/completada sería falso en ambos sentidos.
    if (phase === 5 && input.profile === "quick") {
      reports.push({
        phase,
        label,
        state: "not_applicable",
        reason: "Fase fusionada con la validación de candidatos (fase 3) en el perfil quick.",
      });
      continue;
    }
    if (!complete.has(phase)) {
      reports.push({
        phase,
        label,
        state: "pending",
        reason: `Fase ${phase} no completada en esta corrida.`,
      });
      continue;
    }
    if (phase === 1) {
      reports.push({ phase, label, state: "completed", reason: null });
      continue;
    }
    if (phase === 2) {
      if (coveragePending > 0) {
        reports.push({
          phase,
          label,
          state: "partial",
          reason: `${coveragePending} unidad(es) de cobertura quedaron pendientes de caza.`,
        });
      } else {
        reports.push({ phase, label, state: "completed", reason: null });
      }
      continue;
    }
    if (phase === 3) {
      // El hueco real de fase 3 son los candidatos sin validar y las unidades
      // `candidate` pendientes (NUNCA la cobertura pendiente de caza).
      const gapCount = unvalidated.size > 0 ? unvalidated.size : candidateUnitsPending;
      const consolidationNote = input.consolidatedUnits > 0
        ? ` ${input.consolidatedUnits} unidad(es) consolidadas bajo una canónica.`
        : "";
      if (gapCount === 0) {
        reports.push({ phase, label, state: "completed", reason: null });
        continue;
      }
      if (validationBudgetExhausted) {
        reports.push({
          phase,
          label,
          state: "blocked",
          reason: `${gapCount} candidato(s) sin validar por presupuesto de validación agotado.${consolidationNote}`,
        });
      } else {
        reports.push({
          phase,
          label,
          state: "partial",
          reason: `${gapCount} candidato(s) quedaron sin validación independiente.${consolidationNote}`,
        });
      }
      continue;
    }
    // Fases 4 y 6: un checkpoint completo implica validadores en PASS (un
    // rechazo del validador oficial aborta la fase); el motivo
    // `validator_failed` residual las declara bloqueadas.
    if (validatorFailed) {
      reports.push({
        phase,
        label,
        state: "blocked",
        reason: "Un validador oficial rechazó artefactos de esta fase.",
      });
    } else {
      reports.push({ phase, label, state: "completed", reason: null });
    }
  }
  return reports;
}

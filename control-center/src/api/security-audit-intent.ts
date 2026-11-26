/**
 * Detección conservadora de la intención `security-audit` (español/inglés).
 *
 * Reglas (alineadas con `SKILL.md` § Operating modes):
 * - pregunta general o de metodología → `guidance` (sin clarificación);
 * - solicitud explícita de auditar / pen-test / informe completo → `full_audit`;
 * - corrección o remediación de findings → `remediation`;
 * - ambigüedad (una petición que podría ser guidance o una auditoría completa)
 *   → `guidance` con `requiresClarification=true`.
 *
 * El detector es conservador: sin señal explícita nunca escala a
 * `full_audit`, porque cargar la skill por sí sola no autoriza el flujo completo.
 */

import type { SecurityAuditIntent } from "./security-audit-contracts.js";

export interface SecurityAuditIntentDetection {
  intent: SecurityAuditIntent;
  requiresClarification: boolean;
  matchedSignals: readonly string[];
}

interface IntentSignal {
  id: string;
  pattern: RegExp;
}

const FULL_AUDIT_SIGNALS: readonly IntentSignal[] = [
  { id: "pen-test", pattern: /pen(?:etration)?[\s-]?tests?\b/i },
  { id: "pruebas-de-penetracion", pattern: /\bpruebas?\s+de\s+penetraci[oó]n\b/i },
  { id: "full-audit", pattern: /\bfull[\s-]+(?:security[\s-]+)?audits?\b/i },
  { id: "comprehensive-review", pattern: /\bcomprehensive\s+(?:security\s+)?(?:review|audit)\b/i },
  { id: "end-to-end-review", pattern: /\bend[\s-]to[\s-]end\s+(?:security\s+)?(?:review|audit)\b/i },
  {
    id: "full-security-review",
    pattern: /\b(?:full|complete|in-depth|exhaustive)\s+security\s+(?:review|audit)\b/i,
  },
  {
    id: "audit-codebase",
    pattern:
      /\baudit(?:ing|s)?\s+(?:the\s+|our\s+|this\s+|este\s+|esta\s+|nuestro\s+|nuestra\s+|el\s+|la\s+)?(?:codebase|code|repo(?:sitory)?s?|projects?|services?|apis?|applications?|apps?)\b/i,
  },
  {
    id: "auditoria-completa",
    pattern: /\bauditor[ií]a\s+(?:de\s+seguridad\s+)?(?:completa|integral|exhaustiva|total)\b/i,
  },
  {
    id: "revisar-a-fondo",
    pattern:
      /\b(?:revisar|revisa(?:r)?|revisi[oó]n|review)\s+(?:a\s+fondo|completa|integral)\s+(?:de\s+(?:la\s+)?|la\s+)?seguridad\b/i,
  },
  {
    id: "run-audit",
    pattern:
      /\b(?:haz|realiza|ejecuta|corre|arranca|run|perform|do)\s+(?:una\s+|la\s+|an?\s+|the\s+)?auditor[ií]a\b/i,
  },
  {
    id: "informe-auditoria",
    pattern: /\binforme\s+(?:completo|final)\s+de\s+auditor[ií]a\b/i,
  },
];

const REMEDIATION_SIGNALS: readonly IntentSignal[] = [
  {
    id: "fix-findings",
    pattern:
      /\b(?:fix|patch|resolve|remediate|address)\b[^.!?\n]{0,80}\b(?:findings?|vulnerabilit(?:y|ies)|issues?|weaknesses|misconfigurations?)\b/i,
  },
  {
    id: "findings-fix",
    pattern:
      /\b(?:findings?|vulnerabilit(?:y|ies)|hallazgos?|incidencias|debilidades)\b[^.!?\n]{0,60}\b(?:fix|patch|remediate)\b/i,
  },
  {
    id: "corregir-findings",
    pattern:
      /\b(?:corrige|corregir|remedia|remediar|arregla|arreglar|soluciona|solucionar)\b[^.!?\n]{0,80}\b(?:findings?|hallazgos?|vulnerabilidades|incidencias|debilidades|problemas|recomendaciones)\b/i,
  },
  {
    id: "findings-corregir",
    pattern:
      /\b(?:findings?|hallazgos?|vulnerabilidades|incidencias)\b[^.!?\n]{0,60}\b(?:corrige|corregir|remediar|arreglar)\b/i,
  },
  {
    id: "aplicar-correcciones",
    pattern:
      /\b(?:aplicar|aplica|apply|applying)\s+(?:las\s+|los\s+|the\s+|these\s+)?(?:correcciones|fixes|parches|patches)\b/i,
  },
];

/** Señales que podrían significar guidance o una auditoría completa. */
const AMBIGUOUS_SIGNALS: readonly IntentSignal[] = [
  { id: "security-review", pattern: /\bsecurity\s+review\b/i },
  { id: "revision-seguridad", pattern: /\b(?:revisa(?:r)?|review(?:ing)?|revisi[oó]n)\s+(?:la\s+|el\s+|nuestra\s+|nuestro\s+|the\s+|our\s+)?(?:seguridad|security)\b/i },
  { id: "check-security", pattern: /\bcheck\s+(?:the\s+|our\s+|la\s+|el\s+)?security\b/i },
  {
    id: "revisar-para-seguridad",
    pattern:
      /\b(?:revisar|review)\s+(?:el\s+|la\s+|the\s+)?(?:proyecto|repo(?:sitory)?|codebase)\s+(?:para\s+|for\s+)?seguridad\b/i,
  },
];

/** Ids de ambigüedad security: un guidance con estas señales sí es security. */
export const SECURITY_AMBIGUOUS_SIGNAL_IDS: ReadonlySet<string> = new Set(
  AMBIGUOUS_SIGNALS.map((signal) => signal.id),
);

const GUIDANCE_SIGNALS: readonly IntentSignal[] = [
  { id: "question-mark", pattern: /[¿?]/ },
  {
    id: "wh-question",
    pattern:
      /^(?:what|how|why|which|when|where|who|can|could|should|would|is|are|do|does|explain|describe)\b/i,
  },
  { id: "explicar", pattern: /\b(?:expl[ií]cate?|explicar|expl[ée]rique|describir|describe)\b/i },
  {
    id: "recomendar",
    pattern: /\b(?:recomienda|recomendar|recommend|advice|consejo|orientaci[oó]n|guidance)\b/i,
  },
  { id: "triage", pattern: /\btriage\b|\bclasifica(?:r)?\b/i },
];

function matchSignals(signals: readonly IntentSignal[], text: string): string[] {
  return signals.filter((signal) => signal.pattern.test(text)).map((signal) => signal.id);
}

/**
 * Detecta la intención de una petición. Nunca devuelve `full_audit` sin una
 * señal explícita de auditoría completa; la ambigüedad se resuelve hacia
 * `guidance` pidiendo una sola pregunta de clarificación.
 */
export function detectSecurityAuditIntent(text: string): SecurityAuditIntentDetection {
  if (typeof text !== "string") {
    throw new TypeError("detectSecurityAuditIntent espera un string");
  }
  const normalized = text.trim();
  const fullAudit = matchSignals(FULL_AUDIT_SIGNALS, normalized);
  const remediation = matchSignals(REMEDIATION_SIGNALS, normalized);
  const ambiguous = matchSignals(AMBIGUOUS_SIGNALS, normalized);
  const guidance = matchSignals(GUIDANCE_SIGNALS, normalized);

  if (fullAudit.length > 0 && remediation.length > 0) {
    return {
      intent: "guidance",
      requiresClarification: true,
      matchedSignals: [...fullAudit, ...remediation],
    };
  }
  if (remediation.length > 0) {
    return { intent: "remediation", requiresClarification: false, matchedSignals: remediation };
  }
  if (fullAudit.length > 0) {
    return { intent: "full_audit", requiresClarification: false, matchedSignals: fullAudit };
  }
  if (ambiguous.length > 0) {
    return {
      intent: "guidance",
      requiresClarification: true,
      matchedSignals: [...ambiguous, ...guidance],
    };
  }
  if (guidance.length > 0) {
    return { intent: "guidance", requiresClarification: false, matchedSignals: guidance };
  }
  return { intent: "guidance", requiresClarification: false, matchedSignals: [] };
}

/**
 * Informes determinísticos de un run `security-audit` (fase 6), en español y
 * sin llamadas a ningún modelo.
 *
 * Reglas aplicadas:
 * - Solo existen veredictos oficiales `confirmed | needs_validation | rejected`;
 *   la severidad SOLO aparece en `confirmed` (en los demás se elimina y se
 *   cuenta como `severityStripped`).
 * - Deduplicación por `fingerprint` (predomina el registro más reciente).
 * - `rejected` jamás se describe como hallazgo; `needs_validation` nunca
 *   recibe severidad ni se presenta como vulnerabilidad confirmada.
 * - Un `quick`, con alcance `scope` distinto de `project`, con presupuesto
 *   agotado o incompleto se declara como pasada PARCIAL.
 * - Las notas de hardening van en su propia sección: no se convierten en
 *   vulnerabilidades.
 * - Los IDs y estados oficiales (fingerprints, veredictos, motivos) se
 *   conservan literalmente.
 */

export type SecurityAuditVerdict = "confirmed" | "needs_validation" | "rejected";
export type SecurityAuditSeverity =
  | "critical"
  | "high"
  | "medium"
  | "low"
  | "informational";

export interface SecurityAuditReportFinding {
  fingerprint: string;
  verdict: SecurityAuditVerdict;
  severity?: SecurityAuditSeverity | null;
  title: string;
  description: string;
  /** Ruta relativa al repo (ubicación de origen). */
  location?: string;
  /** Frontera/confianza afectada. */
  boundary?: string;
  impact?: string;
  observedResult?: string;
  remediation?: string;
  principal?: string;
  conditions?: readonly string[];
  /** Solo `needs_validation`: bloqueador exacto y plan acotado. */
  blocker?: string;
  validationPlan?: { local?: string; deployment?: string };
}

export interface SecurityAuditReportCoverage {
  unitsTotal: number;
  unitsCovered: number;
  unitsCandidate: number;
  unitsBlocked: number;
  unitsDeferred: number;
  unitsOutOfScope: number;
  finalCritic?: string;
}

export interface SecurityAuditReportInput {
  runId: string;
  profile: "quick" | "standard" | "deep";
  scopeKind: "project" | "directory" | "component" | "domain" | "git-diff";
  scopePaths?: readonly string[];
  domains?: readonly string[];
  runStatus: "complete" | "incomplete";
  incompleteReason?: string | null;
  sourceRef?: string | null;
  sourceDirty?: boolean;
  executionPolicy: string;
  budget?: { maxInvocations: number | null; spent: number } | null;
  findings: readonly SecurityAuditReportFinding[];
  coverage: SecurityAuditReportCoverage;
  /** Fingerprints sin validar cuando el presupuesto se agota. */
  pendingFingerprints?: readonly string[];
  deferredUnits?: readonly string[];
  hardeningNotes?: readonly string[];
}

export interface SecurityAuditReportStats {
  total: number;
  confirmed: number;
  needsValidation: number;
  rejected: number;
  duplicatesRemoved: number;
  severityStripped: number;
  partialPass: boolean;
}

export interface SecurityAuditReportBundle {
  report: string;
  detail: string;
  needsValidation: string;
  stats: SecurityAuditReportStats;
}

const SEVERITY_ORDER: Record<SecurityAuditSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  informational: 4,
};

const DETAIL_SEVERITIES: readonly SecurityAuditSeverity[] = ["critical", "high", "medium"];

function dedupeFindings(findings: readonly SecurityAuditReportFinding[]): {
  unique: SecurityAuditReportFinding[];
  duplicatesRemoved: number;
} {
  const byFingerprint = new Map<string, SecurityAuditReportFinding>();
  let duplicatesRemoved = 0;
  for (const finding of findings) {
    if (byFingerprint.has(finding.fingerprint)) duplicatesRemoved += 1;
    byFingerprint.set(finding.fingerprint, finding);
  }
  return { unique: [...byFingerprint.values()], duplicatesRemoved };
}

function normalizeFinding(finding: SecurityAuditReportFinding): {
  finding: SecurityAuditReportFinding;
  severityStripped: number;
} {
  if (finding.verdict === "confirmed") return { finding, severityStripped: 0 };
  if (finding.severity === undefined || finding.severity === null) {
    return { finding, severityStripped: 0 };
  }
  const { severity: _dropped, ...rest } = finding;
  return { finding: { ...rest, severity: null }, severityStripped: 1 };
}

function sortFindings(findings: readonly SecurityAuditReportFinding[]): SecurityAuditReportFinding[] {
  return [...findings].sort((a, b) => {
    if (a.verdict !== b.verdict) return a.verdict.localeCompare(b.verdict);
    const severityA = a.severity ? SEVERITY_ORDER[a.severity] : 99;
    const severityB = b.severity ? SEVERITY_ORDER[b.severity] : 99;
    if (severityA !== severityB) return severityA - severityB;
    return a.fingerprint.localeCompare(b.fingerprint);
  });
}

function isPartialPass(input: SecurityAuditReportInput): boolean {
  return (
    input.profile === "quick" ||
    input.scopeKind !== "project" ||
    input.runStatus === "incomplete" || input.coverage.unitsBlocked > 0 ||
    input.coverage.unitsDeferred > 0 || input.coverage.unitsCandidate > 0 ||
    (input.pendingFingerprints?.length ?? 0) > 0
  );
}

function list(items: readonly string[], empty = "ninguno"): string {
  return items.length > 0 ? items.join(", ") : empty;
}

/** Construye los tres informes oficiales de la fase 6. */
export function buildSecurityAuditReports(
  input: SecurityAuditReportInput,
): SecurityAuditReportBundle {
  const { unique, duplicatesRemoved } = dedupeFindings(input.findings);
  let severityStripped = 0;
  const normalized = unique.map((finding) => {
    const result = normalizeFinding(finding);
    severityStripped += result.severityStripped;
    return result.finding;
  });

  const confirmed = sortFindings(normalized.filter((finding) => finding.verdict === "confirmed"));
  const needsValidation = sortFindings(
    normalized.filter((finding) => finding.verdict === "needs_validation"),
  );
  const rejected = sortFindings(normalized.filter((finding) => finding.verdict === "rejected"));
  const pending = [...(input.pendingFingerprints ?? [])].sort();
  const partialPass = isPartialPass(input);

  const stats: SecurityAuditReportStats = {
    total: normalized.length,
    confirmed: confirmed.length,
    needsValidation: needsValidation.length,
    rejected: rejected.length,
    duplicatesRemoved,
    severityStripped,
    partialPass,
  };

  const reportLines: string[] = [];
  reportLines.push(`# Informe de auditoría de seguridad — ${input.runId}`, "");
  if (input.runStatus === "incomplete") {
    reportLines.push(
      "> **ESTADO: INCOMPLETO**" +
        (input.incompleteReason ? ` — motivo oficial \`${input.incompleteReason}\`` : "") +
        ". Esta pasada NO cubre el alcance completo.",
      "",
    );
  } else if (partialPass) {
    reportLines.push(
      "> **PASADA PARCIAL**: " +
        (input.profile === "quick" ? "perfil `quick`" : "") +
        (input.scopeKind !== "project"
          ? `${input.profile === "quick" ? ", " : ""}alcance \`${input.scopeKind}\``
          : "") +
        (pending.length > 0 ? ", presupuesto agotado" : "") +
        ". La cobertura declarada es parcial.",
      "",
    );
  }

  reportLines.push("## 1. Contexto de la corrida", "");
  reportLines.push(`- Perfil: \`${input.profile}\`.`);
  reportLines.push(
    `- Alcance: \`${input.scopeKind}\`` +
      (input.scopePaths?.length ? `; rutas: ${list(input.scopePaths)}` : "") +
      (input.domains?.length ? `; dominios: ${list(input.domains)}` : "") +
      ".",
  );
  reportLines.push(
    `- Referencia de origen: ${input.sourceRef ? `\`${input.sourceRef}\`` : "no declarada"}` +
      `${input.sourceDirty ? " (worktree sucio)" : ""}.`,
  );
  reportLines.push(`- Política de ejecución: \`${input.executionPolicy}\`.`);
  if (input.budget) {
    reportLines.push(
      `- Presupuesto: ${input.budget.maxInvocations === null ? "sin tope" : input.budget.maxInvocations + " invocaciones"}; gastadas: ${input.budget.spent}.`,
    );
  }
  reportLines.push(
    `- Unidades de cobertura: ${input.coverage.unitsTotal} totales; ` +
      `cubiertas ${input.coverage.unitsCovered}, candidatas ${input.coverage.unitsCandidate}, ` +
      `bloqueadas ${input.coverage.unitsBlocked}, diferidas ${input.coverage.unitsDeferred}, ` +
      `fuera de alcance ${input.coverage.unitsOutOfScope}.`,
  );
  if (input.coverage.finalCritic) {
    reportLines.push(`- Crítico final: ${input.coverage.finalCritic}.`);
  }
  if (input.deferredUnits?.length) {
    reportLines.push(`- Unidades diferidas: ${list(input.deferredUnits)}.`);
  }
  reportLines.push("");

  if (pending.length > 0) {
    reportLines.push(
      "## Candidatos sin validar por presupuesto agotado",
      "",
      "Estos fingerprints NO son hallazgos: siguen como candidatos de unidad sin validar.",
      "",
      ...pending.map((fingerprint) => `- \`${fingerprint}\``),
      "",
    );
    if (input.incompleteReason) {
      reportLines.push(`Motivo oficial: \`${input.incompleteReason}\`.`, "");
    }
  }

  reportLines.push("## 2. Postura de seguridad", "");
  reportLines.push(
    confirmed.length === 0
      ? "Sin vulnerabilidades confirmadas en esta pasada; la cobertura declarada es la indicada arriba."
      : `${confirmed.length} hallazgo(s) confirmado(s) tras verificación independiente.`,
    "",
  );

  reportLines.push("## 3. Tabla de hallazgos confirmados", "");
  if (confirmed.length === 0) {
    reportLines.push("_Sin hallazgos confirmados._", "");
  } else {
    reportLines.push("| Severidad | Título | Frontera | Resultado observado |", "| --- | --- | --- | --- |");
    for (const finding of confirmed) {
      reportLines.push(
        `| ${finding.severity ?? "sin clasificar"} | ${finding.title} | ${finding.boundary ?? finding.location ?? "-"} | ${finding.observedResult ?? finding.description} |`,
      );
    }
    reportLines.push("");
    reportLines.push("### Hallazgos confirmados (detalle)", "");
    for (const finding of confirmed) {
      reportLines.push(`#### \`${finding.fingerprint}\` — ${finding.title}`, "");
      reportLines.push(`- Descripción: ${finding.description}`);
      if (finding.location) reportLines.push(`- Ubicación: \`${finding.location}\``);
      if (finding.principal) reportLines.push(`- Principal de menor confianza: ${finding.principal}`);
      if (finding.boundary) reportLines.push(`- Frontera: ${finding.boundary}`);
      if (finding.conditions?.length) reportLines.push(`- Condiciones: ${list(finding.conditions)}`);
      if (finding.impact) reportLines.push(`- Impacto: ${finding.impact}`);
      if (finding.observedResult) reportLines.push(`- Resultado: ${finding.observedResult}`);
      if (finding.remediation) reportLines.push(`- Corrección mínima: ${finding.remediation}`);
      reportLines.push("");
    }
  }

  reportLines.push("## 4. Requiere validación (sin severidad)", "");
  if (needsValidation.length === 0) {
    reportLines.push("_Sin registros pendientes de validación._", "");
  } else {
    reportLines.push("| Título | Traza | Bloqueador |", "| --- | --- | --- |");
    for (const finding of needsValidation) {
      reportLines.push(
        `| ${finding.title} | \`${finding.location ?? finding.fingerprint}\` | ${finding.blocker ?? "no declarado"} |`,
      );
    }
    reportLines.push("");
  }

  if (input.hardeningNotes?.length) {
    reportLines.push("## 5. Notas de hardening (NO son vulnerabilidades)", "");
    reportLines.push(...input.hardeningNotes.map((note) => `- ${note}`), "");
  }

  reportLines.push("## 6. Registros rechazados", "");
  reportLines.push(
    rejected.length === 0
      ? "_Sin registros rechazados._"
      : rejected.map((finding) => `- \`${finding.fingerprint}\`: ${finding.description}`).join("\n"),
    "",
  );
  if (rejected.length > 0) {
    reportLines.push("_Los registros rechazados no se describen como hallazgos._", "");
  }

  const detailLines: string[] = [
    `# Detalle de hallazgos confirmados — ${input.runId}`,
    "",
    "Cada registro conserva su fingerprint y veredicto oficiales.",
    "",
  ];
  const detailFindings = confirmed.filter(
    (finding) => finding.severity !== null && finding.severity !== undefined &&
      DETAIL_SEVERITIES.includes(finding.severity),
  );
  if (detailFindings.length === 0) {
    detailLines.push("_Sin registros confirmados de severidad media, alta o crítica._", "");
  }
  for (const finding of detailFindings) {
    detailLines.push(`## \`${finding.fingerprint}\` (${finding.severity}) — ${finding.title}`, "");
    detailLines.push(finding.description, "");
    if (finding.location) detailLines.push(`- Ubicación: \`${finding.location}\``);
    if (finding.principal) detailLines.push(`- Principal: ${finding.principal}`);
    if (finding.boundary) detailLines.push(`- Frontera: ${finding.boundary}`);
    if (finding.observedResult) detailLines.push(`- Resultado observado: ${finding.observedResult}`);
    if (finding.impact) detailLines.push(`- Impacto: ${finding.impact}`);
    if (finding.remediation) detailLines.push(`- Corrección: ${finding.remediation}`);
    detailLines.push("");
  }

  const needsLines: string[] = [
    `# Registros que requieren validación — ${input.runId}`,
    "",
    "Priorizados como pistas; sin severidad y sin describirse como vulnerabilidades confirmadas.",
    "",
  ];
  if (needsValidation.length === 0) {
    needsLines.push("_Sin registros pendientes._", "");
  }
  for (const finding of needsValidation) {
    needsLines.push(`## \`${finding.fingerprint}\` — ${finding.title}`, "");
    needsLines.push(finding.description, "");
    if (finding.location) needsLines.push(`- Traza de origen: \`${finding.location}\``);
    if (finding.blocker) needsLines.push(`- Bloqueador exacto: ${finding.blocker}`);
    if (finding.validationPlan?.local) {
      needsLines.push(`- Paso local acotado: ${finding.validationPlan.local}`);
    }
    if (finding.validationPlan?.deployment) {
      needsLines.push(`- Observación segura por propietario: ${finding.validationPlan.deployment}`);
    }
    needsLines.push("");
  }
  if (pending.length > 0) {
    needsLines.push("## Candidatos sin validar por presupuesto", "");
    needsLines.push(...pending.map((fingerprint) => `- \`${fingerprint}\``), "");
  }

  return {
    report: reportLines.join("\n"),
    detail: detailLines.join("\n"),
    needsValidation: needsLines.join("\n"),
    stats,
  };
}

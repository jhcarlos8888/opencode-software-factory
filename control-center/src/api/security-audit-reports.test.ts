import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSecurityAuditReports,
  type SecurityAuditReportFinding,
  type SecurityAuditReportInput,
} from "./security-audit-reports.js";

const confirmedHigh: SecurityAuditReportFinding = {
  fingerprint: "src-handler-missing-check",
  verdict: "confirmed",
  severity: "high",
  title: "Comprobación de propiedad ausente",
  description: "Un atacante alcanza una operación sin la comprobación prevista.",
  location: "src/handler.c:10",
  boundary: "Frontera de autorización de objetos",
  principal: "usuario remoto sin privilegios",
  impact: "cambia objetos ajenos",
  observedResult: "el objeto de otro usuario cambia",
  remediation: "comprobar la propiedad antes del cambio",
};

const confirmedMedium: SecurityAuditReportFinding = {
  fingerprint: "src-other-medium",
  verdict: "confirmed",
  severity: "medium",
  title: "Otro hallazgo",
  description: "Violación real de frontera con alcance limitado.",
  location: "src/other.c:5",
};

const needsValidationLead: SecurityAuditReportFinding = {
  fingerprint: "src-parser-size-hypothesis",
  verdict: "needs_validation",
  severity: "critical",
  title: "Tamaño analizado sin comprobar",
  description: "Una hipótesis de frontera bloqueada por código ausente.",
  location: "src/parser.c:42",
  blocker: "el código generado no está en este checkout",
  validationPlan: { local: "generar el parser con una entrada acotada" },
};

const rejectedRecord: SecurityAuditReportFinding = {
  fingerprint: "src-router-auth-bypass",
  verdict: "rejected",
  severity: "high",
  title: "Bypass de autorización alegado",
  description: "Todas las rutas pasan por el envoltorio de autorización.",
};

function input(overrides: Partial<SecurityAuditReportInput> = {}): SecurityAuditReportInput {
  return {
    runId: "run-informes",
    profile: "standard",
    scopeKind: "project",
    runStatus: "complete",
    incompleteReason: null,
    sourceRef: "abc123",
    sourceDirty: false,
    executionPolicy: "source-only",
    budget: { maxInvocations: 12, spent: 9 },
    findings: [confirmedHigh, confirmedMedium, needsValidationLead, rejectedRecord],
    coverage: {
      unitsTotal: 4,
      unitsCovered: 2,
      unitsCandidate: 1,
      unitsBlocked: 0,
      unitsDeferred: 1,
      unitsOutOfScope: 0,
      finalCritic: "sin incidencias",
    },
    pendingFingerprints: [],
    deferredUnits: [],
    hardeningNotes: [],
    ...overrides,
  };
}

test("severity only survives for confirmed records and fingerprints are deduplicated", () => {
  const bundle = buildSecurityAuditReports(
    input({
      findings: [
        confirmedHigh,
        { ...confirmedHigh, title: "Versión más reciente" },
        needsValidationLead,
        rejectedRecord,
        confirmedMedium,
      ],
    }),
  );

  assert.equal(bundle.stats.duplicatesRemoved, 1);
  assert.equal(bundle.stats.total, 4);
  assert.equal(bundle.stats.confirmed, 2);
  assert.equal(bundle.stats.needsValidation, 1);
  assert.equal(bundle.stats.rejected, 1);
  assert.equal(bundle.stats.severityStripped, 2, "needs_validation y rejected sin severidad");

  assert.match(bundle.report, /\| high \|/);
  assert.match(bundle.report, /\| medium \|/);
  assert.equal(bundle.report.includes("| critical |"), false, "sin severidad en needs_validation");
  // La tabla de confirmados usa la versión más reciente del fingerprint.
  assert.match(bundle.report, /Versión más reciente/);

  // El detalle solo incluye confirmados medium/high/critical.
  assert.match(bundle.detail, /src-handler-missing-check/);
  assert.match(bundle.detail, /src-other-medium/);
  assert.equal(bundle.detail.includes("src-parser-size-hypothesis"), false);
  assert.equal(bundle.detail.includes("src-router-auth-bypass"), false);

  // needs_validation aparece sin severidad y con su bloqueador exacto.
  assert.match(bundle.needsValidation, /src-parser-size-hypothesis/);
  assert.match(bundle.needsValidation, /el código generado no está en este checkout/);
  assert.equal(bundle.needsValidation.includes("critical"), false);
});

test("quick, scoped, budget-limited or incomplete runs are declared partial", () => {
  const quick = buildSecurityAuditReports(input({ profile: "quick" }));
  assert.match(quick.report, /PASADA PARCIAL/);
  assert.equal(quick.stats.partialPass, true);

  const scoped = buildSecurityAuditReports(input({ scopeKind: "directory", scopePaths: ["src/api"] }));
  assert.match(scoped.report, /PASADA PARCIAL/);
  assert.match(scoped.report, /`directory`/);
  assert.match(scoped.report, /src\/api/);

  const deferred = buildSecurityAuditReports(input());
  assert.equal(deferred.stats.partialPass, true, "un hueco diferido no es cobertura total");
  const coverage = { ...input().coverage, unitsDeferred: 0, unitsCandidate: 0, unitsCovered: 4 };
  const plain = buildSecurityAuditReports(input({ coverage }));
  assert.equal(plain.report.includes("PASADA PARCIAL"), false);
  assert.equal(plain.stats.partialPass, false);
  const blocked = buildSecurityAuditReports(input({ coverage: { ...coverage, unitsBlocked: 1, unitsCovered: 3 } }));
  assert.equal(blocked.stats.partialPass, true);
});

test("an incomplete run keeps its official reason and lists unvalidated fingerprints", () => {
  const bundle = buildSecurityAuditReports(
    input({
      runStatus: "incomplete",
      incompleteReason: "validation_budget_exhausted",
      pendingFingerprints: ["src-parser-size-hypothesis", "src-other-medium"],
    }),
  );
  assert.match(bundle.report, /ESTADO: INCOMPLETO/);
  assert.match(bundle.report, /validation_budget_exhausted/);
  assert.match(bundle.report, /src-parser-size-hypothesis/);
  assert.match(bundle.report, /NO son hallazgos/);
  assert.match(bundle.needsValidation, /src-parser-size-hypothesis/);
  assert.equal(bundle.stats.partialPass, true);
});

test("hardening notes never become findings and rejected records stay out of the table", () => {
  const bundle = buildSecurityAuditReports(
    input({ hardeningNotes: ["Aplicar cabeceras estrictas de seguridad en despliegue"] }),
  );
  assert.match(bundle.report, /Notas de hardening \(NO son vulnerabilidades\)/);
  const confirmedTable = bundle.report.split("## 3. Tabla de hallazgos confirmados")[1]
    ?.split("### Hallazgos confirmados")[0] ?? "";
  assert.equal(confirmedTable.includes("Aplicar cabeceras estrictas"), false);
  assert.equal(confirmedTable.includes("src-router-auth-bypass"), false);
  assert.match(bundle.report, /no se describen como hallazgos/);
  assert.equal(bundle.report.includes("Bypass de autorización alegado"), false);
});

test("reports are deterministic and keep official identifiers in Spanish prose", () => {
  const first = buildSecurityAuditReports(input());
  const second = buildSecurityAuditReports(input());
  assert.equal(first.report, second.report);
  assert.equal(first.detail, second.detail);
  assert.equal(first.needsValidation, second.needsValidation);

  assert.match(first.report, /# Informe de auditoría de seguridad — run-informes/);
  assert.match(first.report, /Perfil: `standard`/);
  assert.match(first.report, /Política de ejecución: `source-only`/);
  assert.match(first.report, /src-handler-missing-check/);
  assert.match(first.report, /abc123/);
  assert.equal(first.report.includes("undefined"), false);
  assert.equal(first.report.includes("[object Object]"), false);
});

test("budget-exhausted runs list pending fingerprints as candidates, not findings", () => {
  const bundle = buildSecurityAuditReports(
    input({
      runStatus: "incomplete",
      incompleteReason: "validation_budget_exhausted",
      pendingFingerprints: ["fp-pendiente"],
      findings: [confirmedHigh],
    }),
  );
  const candidatesSection = bundle.report.split(
    "## Candidatos sin validar por presupuesto agotado",
  )[1] ?? "";
  assert.match(candidatesSection, /fp-pendiente/);
  assert.match(candidatesSection, /NO son hallazgos/);
  assert.equal(candidatesSection.includes("| fp-pendiente |"), false, "no entra en la tabla");
  assert.equal(bundle.stats.confirmed, 1);
});

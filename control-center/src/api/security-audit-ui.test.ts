import assert from "node:assert/strict";
import { test } from "node:test";
import { SECURITY_AUDIT_DOMAINS as OFFICIAL_DOMAINS } from "./security-audit-contracts.js";
import {
  SECURITY_AUDIT_DOMAINS,
  SECURITY_AUDIT_PHASES,
  SECURITY_AUDIT_REPORT_FILES,
  buildSecurityAuditRemediationPayload,
  buildSecurityAuditScope,
  buildSecurityAuditStartPayload,
  formatSecurityAuditTime,
  securityAuditIncompleteReasonLabel,
  securityAuditOutcomeLabel,
  securityAuditPhaseBreakdown,
  securityAuditPhaseLabel,
  securityAuditProgress,
  securityAuditProgressSummary,
  securityAuditReportUrl,
  securityAuditRunStatusLabel,
  securityAuditScopeRequiresPaths,
  securityAuditScopeRequiresRefs,
  securityAuditSeverityLabel,
  shouldPollSecurityAudit,
  securityAuditStatusIncompleteReasons,
  splitSecurityAuditIncompleteReasons,
} from "../web/security-operations.js";

test("UI domain list matches the official companion domains", () => {
  assert.deepEqual([...SECURITY_AUDIT_DOMAINS], [...OFFICIAL_DOMAINS]);
  assert.equal(SECURITY_AUDIT_DOMAINS.length, 10);
});

test("UI download allowlist matches the server allowlist", () => {
  assert.deepEqual([...SECURITY_AUDIT_REPORT_FILES], [
    "run-metadata.json",
    "architecture.md",
    "coverage-ledger.json",
    "findings.json",
    "REPORT.md",
    "FINDINGS-DETAIL.md",
    "NEEDS-VALIDATION.md",
  ]);
});

test("phase and status labels are Spanish and cover the official states", () => {
  assert.equal(SECURITY_AUDIT_PHASES.length, 6);
  assert.equal(SECURITY_AUDIT_PHASES[0]?.label, "Reconocimiento");
  assert.equal(securityAuditPhaseLabel("pending"), "Pendiente");
  assert.equal(securityAuditPhaseLabel("in_progress"), "En curso");
  assert.equal(securityAuditPhaseLabel("complete"), "Completada");
  assert.equal(securityAuditPhaseLabel("skipped"), "Omitida");
  // Paquete 6: una fase parcial o bloqueada nunca se rotula "Completada".
  assert.equal(securityAuditPhaseLabel("partial"), "Parcial");
  assert.equal(securityAuditPhaseLabel("blocked"), "Bloqueada");
  assert.equal(securityAuditPhaseLabel("not_applicable"), "No aplicable");
  assert.equal(securityAuditRunStatusLabel("in_progress"), "En curso");
  assert.equal(securityAuditRunStatusLabel("incomplete"), "Incompleta");
  assert.equal(securityAuditOutcomeLabel("failed"), "Fallida");
  assert.equal(securityAuditSeverityLabel("high"), "Alta");
  assert.equal(securityAuditSeverityLabel(null), "Sin clasificar");
  assert.match(
    securityAuditIncompleteReasonLabel("validation_budget_exhausted"),
    /presupuesto/,
  );
  assert.equal(securityAuditIncompleteReasonLabel(null), "");
});

test("progress counts completed phases out of six", () => {
  assert.deepEqual(
    securityAuditProgress(["complete", "complete", "pending", "pending", "pending", "pending"]),
    { completed: 2, total: 6, percent: 33 },
  );
  assert.equal(securityAuditProgress([]).percent, 0);
  assert.equal(securityAuditProgress(["complete", "complete", "complete", "complete", "complete", "complete"]).percent, 100);
});

test("Paquete 6: phase breakdown counts every real state and reasons split primary/additional", () => {
  const breakdown = securityAuditPhaseBreakdown([
    { state: "completed" },
    { state: "partial" },
    { state: "blocked" },
    { state: "not_applicable" },
    { state: "pending" },
    { state: "pending" },
  ]);
  assert.deepEqual(breakdown, {
    completed: 1, partial: 1, blocked: 1, notApplicable: 1, pending: 2,
  });
  // Sin desglose de la API el componente degrada a ceros (no inventa estados).
  assert.deepEqual(securityAuditPhaseBreakdown([]), {
    completed: 0, partial: 0, blocked: 0, notApplicable: 0, pending: 0,
  });

  const split = splitSecurityAuditIncompleteReasons("validation_budget_exhausted", [
    "validation_budget_exhausted",
    "orchestrator_failed",
  ]);
  assert.equal(split.primary, "validation_budget_exhausted");
  assert.deepEqual(split.additional, ["orchestrator_failed"]);

  // API antigua (sin lista): el primario sigue y no hay adicionales.
  const legacy = splitSecurityAuditIncompleteReasons("deadline_exceeded", undefined);
  assert.equal(legacy.primary, "deadline_exceeded");
  assert.deepEqual(legacy.additional, []);
  // Sin primario explícito: se toma el primero de la lista.
  const fallback = splitSecurityAuditIncompleteReasons(null, ["a", "b"]);
  assert.equal(fallback.primary, "a");
  assert.deepEqual(fallback.additional, ["b"]);
});

test("Paquete 6: 100% solo en runs complete y mapeo real de etiquetas por fase", () => {
  // Run completo: comportamiento previo intacto.
  assert.equal(
    securityAuditProgressSummary(
      "complete",
      ["complete", "complete", "complete", "complete", "complete", "complete"],
    ),
    "Progreso 6/6 fases (100%)",
  );
  // Run INCOMPLETO que recorrió 6/6 con solo 3 fases realmente completadas:
  // sin "Progreso" ni "100%"; recorridas ≠ completadas.
  const line = securityAuditProgressSummary(
    "incomplete",
    ["complete", "complete", "complete", "complete", "complete", "complete"],
    3,
  );
  assert.equal(line, "Fases recorridas: 6/6 · Completadas: 3/6");
  assert.equal(line.includes("100%"), false, "un run no complete jamás muestra 100%");
  assert.equal(line.includes("Progreso"), false);
  // Con fases pendientes el recorrido refleja lo abierto (checkpoint).
  assert.equal(
    securityAuditProgressSummary(
      "in_progress",
      ["complete", "in_progress", "pending", "pending", "pending", "pending"],
      1,
    ),
    "Fases recorridas: 2/6 · Completadas: 1/6",
  );
  // Sin desglose (API antigua): el checkpoint es el único dato disponible.
  assert.equal(
    securityAuditProgressSummary(
      "incomplete",
      ["complete", "complete", "pending", "pending", "pending", "pending"],
    ),
    "Fases recorridas: 2/6 · Completadas: 2/6",
  );
  // Mapeo estado de fase → etiqueta real que usan las tarjetas: el desglose
  // usa "completed" (distinto del checkpoint "complete") y ambas son
  // "Completada"; parcial/bloqueada jamás dicen "Completada".
  assert.equal(securityAuditPhaseLabel("completed"), "Completada");
  assert.equal(securityAuditPhaseLabel("partial"), "Parcial");
  assert.equal(securityAuditPhaseLabel("blocked"), "Bloqueada");
  assert.equal(securityAuditPhaseLabel("not_applicable"), "No aplicable");
  assert.equal(securityAuditPhaseLabel("pending"), "Pendiente");
  assert.notEqual(securityAuditPhaseLabel("partial"), securityAuditPhaseLabel("completed"));
});

test("Paquete 6: incompleteReasons se lee de la RAÍZ del payload real (y del run antiguo)", () => {
  // Forma REAL de la API: la lista completa vive en la raíz del payload de
  // estado; `run` solo lleva el primario. Primary + adicionales correctos.
  const rootPayload = securityAuditStatusIncompleteReasons({
    incompleteReasons: ["validation_budget_exhausted", "orchestrator_failed"],
    run: { incompleteReason: "validation_budget_exhausted" },
  });
  const real = splitSecurityAuditIncompleteReasons("validation_budget_exhausted", rootPayload);
  assert.equal(real.primary, "validation_budget_exhausted");
  assert.deepEqual(real.additional, ["orchestrator_failed"]);
  // Forma antigua: lista anidada dentro de `run` sigue funcionando.
  assert.deepEqual(
    securityAuditStatusIncompleteReasons({
      run: { incompleteReasons: ["deadline_exceeded"] },
    }),
    ["deadline_exceeded"],
  );
  // La raíz manda sobre la forma antigua si ambas existieran.
  assert.deepEqual(
    securityAuditStatusIncompleteReasons({
      incompleteReasons: ["validator_failed"],
      run: { incompleteReasons: ["deadline_exceeded"] },
    }),
    ["validator_failed"],
  );
  // Sin listas en ningún nivel → undefined (el primario persistido sigue).
  assert.equal(securityAuditStatusIncompleteReasons({ run: {} }), undefined);
  assert.equal(securityAuditStatusIncompleteReasons(null), undefined);
});

test("polling continues through a cancellation request until a terminal state", () => {
  assert.equal(shouldPollSecurityAudit(null), false);
  assert.equal(shouldPollSecurityAudit(undefined), false);
  assert.equal(shouldPollSecurityAudit({ runStatus: "in_progress", cancelRequested: false }), true);
  assert.equal(shouldPollSecurityAudit({ runStatus: "in_progress", cancelRequested: true }), true);
  assert.equal(shouldPollSecurityAudit({ runStatus: "complete", cancelRequested: false }), false);
  assert.equal(shouldPollSecurityAudit({ runStatus: "incomplete", cancelRequested: false }), false);
  assert.equal(shouldPollSecurityAudit({ runStatus: "incomplete", cancelRequested: true }), false);
});

test("report URLs encode both segments to block traversal", () => {
  assert.equal(
    securityAuditReportUrl("run-1", "REPORT.md"),
    "/api/security-audit/runs/run-1/reports/REPORT.md",
  );
  const crafted = securityAuditReportUrl("../../etc", "../../passwd");
  assert.equal(crafted.includes(".."), false);
  assert.ok(crafted.includes("%2E%2E") || !crafted.includes(".."));
});

test("scope draft builder enforces per-kind requirements", () => {
  const project = buildSecurityAuditScope({
    kind: "project", pathsText: "", domains: [], baseRef: "", headRef: "",
  });
  assert.equal(project.ok, true);
  if (project.ok) assert.deepEqual(project.scope, { kind: "project" });

  const directoryMissing = buildSecurityAuditScope({
    kind: "directory", pathsText: "\n  ", domains: [], baseRef: "", headRef: "",
  });
  assert.equal(directoryMissing.ok, false);

  const directory = buildSecurityAuditScope({
    kind: "component", pathsText: "src/api\n\nsrc/lib\n", domains: [], baseRef: "", headRef: "",
  });
  assert.equal(directory.ok, true);
  if (directory.ok) assert.deepEqual(directory.scope, {
    kind: "component", scopePaths: ["src/api", "src/lib"],
  });

  const domainMissing = buildSecurityAuditScope({
    kind: "domain", pathsText: "", domains: [], baseRef: "", headRef: "",
  });
  assert.equal(domainMissing.ok, false);

  const domain = buildSecurityAuditScope({
    kind: "domain", pathsText: "", domains: ["WEB-PROTOCOL-AND-AUTH"], baseRef: "", headRef: "",
  });
  assert.equal(domain.ok, true);

  const diffMissing = buildSecurityAuditScope({
    kind: "git-diff", pathsText: "", domains: [], baseRef: "abc", headRef: "",
  });
  assert.equal(diffMissing.ok, false);

  const diffEqual = buildSecurityAuditScope({
    kind: "git-diff", pathsText: "", domains: [], baseRef: "abc", headRef: "abc",
  });
  assert.equal(diffEqual.ok, false);

  const diff = buildSecurityAuditScope({
    kind: "git-diff", pathsText: "src/api", domains: [], baseRef: "abc", headRef: "def",
  });
  assert.equal(diff.ok, true);
  if (diff.ok) assert.deepEqual(diff.scope, {
    kind: "git-diff", baseRef: "abc", headRef: "def", scopePaths: ["src/api"],
  });

  assert.equal(securityAuditScopeRequiresPaths("directory"), true);
  assert.equal(securityAuditScopeRequiresPaths("project"), false);
  assert.equal(securityAuditScopeRequiresRefs("git-diff"), true);
  assert.equal(securityAuditScopeRequiresRefs("domain"), false);
});

test("timestamps render as em dash when absent and raw when unparseable", () => {
  assert.equal(formatSecurityAuditTime(null), "—");
  assert.equal(formatSecurityAuditTime(undefined), "—");
  assert.equal(formatSecurityAuditTime("no-es-fecha"), "no-es-fecha");
  assert.notEqual(formatSecurityAuditTime("2026-01-01T00:00:00.000Z"), "2026-01-01T00:00:00.000Z");
});

test("M5: the UI start payload matches the API contract exactly", () => {
  const payload = buildSecurityAuditStartPayload({
    projectPath: "/srv/example",
    researchDepth: "deep",
    profile: "standard",
    scope: { kind: "project" },
    budget: { maxInvocations: 20, maxConcurrency: 2, maxDurationMs: 600000 },
  });
  assert.deepEqual(Object.keys(payload).sort(), [
    "budget", "path", "preflightDepth", "profile", "scope",
  ]);
  assert.equal(payload.path, "/srv/example");
  assert.equal(payload.preflightDepth, "deep", "usa la profundidad real, nunca un valor fijo");
  assert.equal(payload.profile, "standard");
  assert.deepEqual(payload.budget, { maxInvocations: 20, maxConcurrency: 2, maxDurationMs: 600000 });

  const quick = buildSecurityAuditStartPayload({
    projectPath: "/srv/otro",
    researchDepth: "quick",
    profile: "quick",
    scope: { kind: "directory", scopePaths: ["src/api"] },
    budget: { maxInvocations: null, maxConcurrency: 1, maxDurationMs: 60000 },
  });
  assert.equal(quick.preflightDepth, "quick");
  assert.equal((quick.budget as { maxInvocations: number | null }).maxInvocations, null);
});

test("Paquete 7: the UI start payload carries trimmed instructions and omits empty ones", () => {
  const withText = buildSecurityAuditStartPayload({
    projectPath: "/srv/example",
    researchDepth: "deep",
    profile: "standard",
    scope: { kind: "project" },
    budget: { maxInvocations: 20, maxConcurrency: 2, maxDurationMs: 600000 },
    instructions: "  Prioriza la superficie de autenticación.  ",
  });
  assert.equal(withText.instructions, "Prioriza la superficie de autenticación.");

  // Sin instrucción (o solo espacios): la clave se OMITE para que la API use
  // su texto por defecto.
  const withoutText = buildSecurityAuditStartPayload({
    projectPath: "/srv/example",
    researchDepth: "deep",
    profile: "standard",
    scope: { kind: "project" },
    budget: { maxInvocations: 20, maxConcurrency: 2, maxDurationMs: 600000 },
  });
  assert.equal("instructions" in withoutText, false);
  assert.deepEqual(Object.keys(withoutText).sort(), [
    "budget", "path", "preflightDepth", "profile", "scope",
  ]);

  const whitespaceOnly = buildSecurityAuditStartPayload({
    projectPath: "/srv/example",
    researchDepth: "deep",
    profile: "standard",
    scope: { kind: "project" },
    budget: { maxInvocations: 20, maxConcurrency: 2, maxDurationMs: 600000 },
    instructions: "   \n  ",
  });
  assert.equal("instructions" in whitespaceOnly, false);
});

test("Paquete 7 (revisión): a 9000-char instruction is capped to exactly 8000 preserving the prefix", () => {
  const long = "prefijo relevante de la instrucción " + "y".repeat(9000);
  const payload = buildSecurityAuditStartPayload({
    projectPath: "/srv/example",
    researchDepth: "deep",
    profile: "standard",
    scope: { kind: "project" },
    budget: { maxInvocations: 20, maxConcurrency: 2, maxDurationMs: 600000 },
    instructions: long,
  });
  const instructions = payload.instructions;
  assert.equal(typeof instructions, "string");
  assert.equal((instructions as string).length, 8000, "el payload lleva exactamente 8000");
  assert.ok(
    (instructions as string).startsWith("prefijo relevante de la instrucción"),
    "el texto conserva el prefijo (el exceso se descarta por el final)",
  );
});

test("M5: the UI remediation payload carries approved, path and the real depth", () => {
  const payload = buildSecurityAuditRemediationPayload({
    projectPath: "/srv/example",
    researchDepth: "focused",
    fingerprints: ["fp-1", "fp-2"],
  });
  assert.deepEqual(Object.keys(payload).sort(), [
    "approved", "fingerprints", "path", "preflightDepth",
  ]);
  assert.equal(payload.approved, true);
  assert.equal(payload.path, "/srv/example");
  assert.equal(payload.preflightDepth, "focused");
  assert.deepEqual(payload.fingerprints, ["fp-1", "fp-2"]);
});

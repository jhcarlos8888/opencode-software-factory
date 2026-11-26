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
  securityAuditPhaseLabel,
  securityAuditProgress,
  securityAuditReportUrl,
  securityAuditRunStatusLabel,
  securityAuditScopeRequiresPaths,
  securityAuditScopeRequiresRefs,
  securityAuditSeverityLabel,
  shouldPollSecurityAudit,
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

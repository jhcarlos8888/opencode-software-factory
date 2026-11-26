import assert from "node:assert/strict";
import test from "node:test";
import {
  SECURITY_AUDIT_BUDGET_INCOMPLETE_REASONS,
  SECURITY_AUDIT_DOMAINS,
  SECURITY_AUDIT_INCOMPLETE_REASONS,
  SECURITY_AUDIT_PHASES,
  classifySecurityAuditProviderError,
  completeSecurityAuditRun,
  createSecurityAuditRemediationRequest,
  createSecurityAuditRunState,
  isSecurityAuditDomain,
  markSecurityAuditRunIncomplete,
  planForSecurityAuditIntent,
  securityAuditDomainDocument,
  validateSecurityAuditBudgetConfig,
  validateSecurityAuditScope,
} from "./security-audit-contracts.js";
import { detectSecurityAuditIntent } from "./security-audit-intent.js";

// Contratos + intención: los contratos no tienen fichero de pruebas propio en
// esta ola, así que su validación runtime vive aquí junto al detector.

test("official six phases and incomplete reasons are fixed", () => {
  assert.deepEqual([...SECURITY_AUDIT_PHASES], [
    "reconnaissance",
    "coverage-hunting-waves",
    "candidate-validation",
    "structured-output",
    "independent-record-verification",
    "target-neutral-report",
  ]);
  assert.equal(SECURITY_AUDIT_PHASES.length, 6);
  assert.deepEqual([...SECURITY_AUDIT_INCOMPLETE_REASONS], [
    "budget_cannot_fund_reconnaissance_and_reserves",
    "budget_cannot_reserve_critics_and_validation",
    "critic_budget_exhausted",
    "validation_budget_exhausted",
    "validator_failed",
    "orchestrator_failed",
    "provider_unavailable",
    "cancelled_by_user",
    "deadline_exceeded",
    "execution_interrupted",
  ]);
  // Los cuatro motivos oficiales de presupuesto se conservan intactos.
  assert.deepEqual([...SECURITY_AUDIT_BUDGET_INCOMPLETE_REASONS], [
    "budget_cannot_fund_reconnaissance_and_reserves",
    "budget_cannot_reserve_critics_and_validation",
    "critic_budget_exhausted",
    "validation_budget_exhausted",
  ]);
});

test("official domains come from the companion documents of the skill", () => {
  assert.equal(SECURITY_AUDIT_DOMAINS.length, 10);
  for (const domain of SECURITY_AUDIT_DOMAINS) {
    assert.equal(securityAuditDomainDocument(domain), `${domain}.md`);
    assert.ok(isSecurityAuditDomain(domain));
  }
  // Fases/metodología no son dominios companion.
  for (const notADomain of ["SKILL", "HUNTING", "RECONNAISSANCE", "ATTACK-CLASSES", "VALIDATION-AND-REPORTING"]) {
    assert.equal(isSecurityAuditDomain(notADomain), false);
    assert.equal(securityAuditDomainDocument(notADomain), null);
  }
});

test("scope validation accepts every official kind with its required fields", () => {
  const project = validateSecurityAuditScope({ kind: "project" });
  assert.equal(project.ok, true);

  const directory = validateSecurityAuditScope({ kind: "directory", scopePaths: ["src/api"] });
  assert.equal(directory.ok, true);
  if (directory.ok) {
    assert.deepEqual(directory.value.scopePaths, ["src/api"]);
    assert.deepEqual(directory.value.domains, []);
  }

  const domain = validateSecurityAuditScope({ kind: "domain", domains: ["WEB-PROTOCOL-AND-AUTH"] });
  assert.equal(domain.ok, true);

  const diff = validateSecurityAuditScope({
    kind: "git-diff",
    baseRef: "abc123",
    headRef: "def456",
    scopePaths: ["src/api"],
    domains: ["CLOUD-AND-DEPLOYMENT"],
  });
  assert.equal(diff.ok, true);
  if (diff.ok) {
    assert.equal(diff.value.baseRef, "abc123");
    assert.equal(diff.value.headRef, "def456");
  }
});

test("scope validation rejects traversal, unknown domains and incomplete git-diff", () => {
  assert.equal(validateSecurityAuditScope({ kind: "directory", scopePaths: [] }).ok, false);
  assert.equal(validateSecurityAuditScope({ kind: "directory", scopePaths: ["../etc"] }).ok, false);
  assert.equal(validateSecurityAuditScope({ kind: "directory", scopePaths: ["/etc"] }).ok, false);
  assert.equal(
    validateSecurityAuditScope({ kind: "directory", scopePaths: ["src", "src"] }).ok,
    false,
  );
  assert.equal(validateSecurityAuditScope({ kind: "domain", domains: ["HUNTING"] }).ok, false);
  assert.equal(
    validateSecurityAuditScope({ kind: "git-diff", baseRef: "abc" }).ok,
    false,
  );
  assert.equal(
    validateSecurityAuditScope({ kind: "git-diff", baseRef: "same", headRef: "same" }).ok,
    false,
  );
  assert.equal(
    validateSecurityAuditScope({ kind: "project", scopePaths: ["src"] }).ok,
    false,
  );
  assert.equal(validateSecurityAuditScope("project").ok, false);
});

test("run states only allow the four official incomplete reasons", () => {
  assert.deepEqual(createSecurityAuditRunState(), { status: "in_progress", reason: null });
  const complete = completeSecurityAuditRun(createSecurityAuditRunState());
  assert.equal(complete.ok, true);
  if (complete.ok) assert.deepEqual(complete.value, { status: "complete", reason: null });

  const incomplete = markSecurityAuditRunIncomplete("validation_budget_exhausted");
  assert.equal(incomplete.ok, true);
  assert.equal(markSecurityAuditRunIncomplete("budget_exhausted").ok, false);
  assert.equal(markSecurityAuditRunIncomplete(undefined).ok, false);
  assert.equal(completeSecurityAuditRun({ status: "incomplete", reason: "critic_budget_exhausted" }).ok, false);
});

test("guidance creates no artifacts or six-phase plan while full audit does", () => {
  const guidance = planForSecurityAuditIntent("guidance");
  assert.equal(guidance.createsArtifacts, false);
  assert.equal(guidance.sixPhasePlan, false);
  assert.deepEqual(guidance.phases, []);

  const fullAudit = planForSecurityAuditIntent("full_audit");
  assert.equal(fullAudit.createsArtifacts, true);
  assert.equal(fullAudit.sixPhasePlan, true);
  assert.equal(fullAudit.phases.length, 6);
  assert.equal(fullAudit.phases[0], "reconnaissance");
  assert.equal(fullAudit.phases[5], "target-neutral-report");

  const remediation = planForSecurityAuditIntent("remediation");
  assert.equal(remediation.createsArtifacts, false);
  assert.equal(remediation.sixPhasePlan, false);
  assert.deepEqual(remediation.phases, []);
});

test("remediation requires fingerprints and never touches the audited target", () => {
  assert.equal(
    createSecurityAuditRemediationRequest({ requestId: "fix-1", targetRunId: "run-7", fingerprints: [] }).ok,
    false,
  );
  assert.equal(
    createSecurityAuditRemediationRequest({
      requestId: "Fix 1",
      targetRunId: "run-7",
      fingerprints: ["src-handler-missing-check"],
    }).ok,
    false,
  );
  assert.equal(
    createSecurityAuditRemediationRequest({
      requestId: "fix-1",
      targetRunId: "run-7",
      fingerprints: ["dup", "dup"],
    }).ok,
    false,
  );

  const fingerprints = ["src-handler-missing-check"];
  const created = createSecurityAuditRemediationRequest({
    requestId: "fix-1",
    targetRunId: "run-7",
    fingerprints,
  });
  assert.equal(created.ok, true);
  if (created.ok) {
    assert.equal(created.value.kind, "remediation");
    assert.equal(created.value.modifiesAuditedTarget, false);
    assert.equal(created.value.independent, true);
    assert.equal(created.value.targetRunId, "run-7");
    assert.notEqual(created.value, fingerprints);
  }
  // La función es pura: no muta la entrada.
  assert.deepEqual(fingerprints, ["src-handler-missing-check"]);
});

test("budget config validation enforces integers and null maxInvocations", () => {
  const ok = validateSecurityAuditBudgetConfig({
    maxInvocations: 12,
    maxConcurrency: 3,
    maxDurationMs: 600000,
  });
  assert.equal(ok.ok, true);
  assert.equal(
    validateSecurityAuditBudgetConfig({ maxInvocations: null, maxConcurrency: 1, maxDurationMs: 1 }).ok,
    true,
  );
  assert.equal(
    validateSecurityAuditBudgetConfig({ maxInvocations: 12, maxConcurrency: 0, maxDurationMs: 1 }).ok,
    false,
  );
  assert.equal(
    validateSecurityAuditBudgetConfig({ maxInvocations: 12, maxConcurrency: 1.5, maxDurationMs: 1 }).ok,
    false,
  );
  assert.equal(
    validateSecurityAuditBudgetConfig({ maxInvocations: -1, maxConcurrency: 1, maxDurationMs: 1 }).ok,
    false,
  );
  assert.equal(
    validateSecurityAuditBudgetConfig({ maxInvocations: 12, maxConcurrency: 1, maxDurationMs: 0 }).ok,
    false,
  );
});

test("provider errors are classified without automatic prompt replay", () => {
  const rateLimited = classifySecurityAuditProviderError(429);
  assert.equal(rateLimited.kind, "rate_limited");
  assert.equal(rateLimited.retryable, true);
  assert.equal(rateLimited.autoReplay, false);

  assert.equal(classifySecurityAuditProviderError({ status: 401 }).kind, "auth");
  assert.equal(classifySecurityAuditProviderError({ statusCode: 503 }).kind, "server_error");
  assert.equal(classifySecurityAuditProviderError({ code: "ETIMEDOUT" }).kind, "timeout");
  assert.equal(classifySecurityAuditProviderError(400).kind, "invalid_request");
  const unknown = classifySecurityAuditProviderError("boom");
  assert.equal(unknown.kind, "unknown");
  assert.equal(unknown.autoReplay, false);
  // Nunca se reenvía un prompt de forma automática, aunque sea reintentable.
  for (const status of [429, 401, 408, 500, 400, null]) {
    const classification = classifySecurityAuditProviderError(status);
    assert.equal(classification.autoReplay, false);
  }
});

test("general questions are guidance without clarification", () => {
  for (const question of [
    "¿Qué es una validación de dependencias?",
    "How do I review pull requests safely?",
    "explain how the coverage ledger works",
    "¿Puedes recomendar una estrategia de triage?",
  ]) {
    const detection = detectSecurityAuditIntent(question);
    assert.equal(detection.intent, "guidance", question);
    assert.equal(detection.requiresClarification, false, question);
  }
});

test("explicit audit, pen-test and full report requests map to full_audit", () => {
  for (const request of [
    "Run a pen test on this service",
    "haz una auditoría completa del repositorio",
    "audit the repository end to end",
    "full security review of the control center",
    "necesito el informe completo de auditoría",
    "realiza una auditoría de seguridad del proyecto",
    "prueba de penetración de la API",
  ]) {
    const detection = detectSecurityAuditIntent(request);
    assert.equal(detection.intent, "full_audit", request);
    assert.equal(detection.requiresClarification, false, request);
    assert.ok(detection.matchedSignals.length > 0, request);
  }
});

test("explicit finding fixes map to remediation", () => {
  for (const request of [
    "fix the findings from the last run",
    "corrige los hallazgos de la auditoría",
    "remediate the high severity vulnerabilities",
    "aplicar las correcciones propuestas",
    "arregla las incidencias encontradas",
  ]) {
    const detection = detectSecurityAuditIntent(request);
    assert.equal(detection.intent, "remediation", request);
    assert.equal(detection.requiresClarification, false, request);
  }
});

test("ambiguous review requests fall back to guidance with clarification", () => {
  for (const request of [
    "review the security of this project",
    "revisa la seguridad del módulo de pagos",
    "¿puedes revisar la seguridad?",
    "check security before we ship",
  ]) {
    const detection = detectSecurityAuditIntent(request);
    assert.equal(detection.intent, "guidance", request);
    assert.equal(detection.requiresClarification, true, request);
    assert.ok(detection.matchedSignals.length > 0, request);
  }
});

test("mixed full-audit and remediation signals are ambiguous", () => {
  const detection = detectSecurityAuditIntent(
    "haz una auditoría completa y corrige los findings",
  );
  assert.equal(detection.intent, "guidance");
  assert.equal(detection.requiresClarification, true);
});

test("the detector stays conservative without explicit audit signals", () => {
  for (const text of [
    "seguridad",
    "auditoría de seguridad",
    "quiero hablar del tema security",
    "",
  ]) {
    const detection = detectSecurityAuditIntent(text);
    assert.equal(detection.intent, "guidance", text);
    assert.notEqual(detection.intent, "full_audit", text);
  }
  assert.equal(detectSecurityAuditIntent("security").requiresClarification, false);
});

test("non-string input is rejected loudly", () => {
  assert.throws(() => detectSecurityAuditIntent(undefined as unknown as string), TypeError);
});

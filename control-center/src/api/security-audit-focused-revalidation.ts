import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ExecutionSnapshot } from "./database.js";
import { getSecurityAuditRun, listSecurityAuditFindings, listSecurityAuditRemediations } from "./security-audit-persistence.js";
import { readSecurityAuditArtifact, readSecurityAuditSourceSnapshot, resolveSecurityAuditRunDirectory } from "./security-audit-artifacts.js";
import { resolveSecurityAuditScopeFiles, snapshotSecurityAuditScope } from "./security-audit-scope.js";
import { validateCoverageLedgerFile, validateFindingsFile } from "./security-audit-upstream.js";
import type { SecurityAuditRosterEntry } from "./security-audit-orchestrator.js";
import type { SecurityAuditScope } from "./security-audit-contracts.js";

export const FOCUSED_REVALIDATION_BUDGET = Object.freeze({
  maxInvocations: 2, maxConcurrency: 1, maxDurationMs: 600_000,
});
const MAX_PATHS = 16;
const RUN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FINGERPRINT = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function sha(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Scope comes from the original official finding, not arbitrary client input.
 * Reject ambiguous/noncanonical paths instead of silently ignoring evidence. */
export function focusedFindingPaths(payload: unknown): { findingPath: string; paths: string[] } {
  requireCondition(record(payload) && payload.verdict === "confirmed", "Se exige un registro confirmed original.");
  const trace = Array.isArray(payload.trace) ? payload.trace : [];
  const evidence = Array.isArray(payload.evidence) ? payload.evidence : [];
  requireCondition(trace.length > 0, "El hallazgo no conserva una traza oficial.");
  const entries = [...trace, ...evidence];
  const paths = new Set<string>();
  for (const entry of entries) {
    requireCondition(record(entry) && typeof entry.file === "string" &&
      typeof entry.line === "number" && Number.isSafeInteger(entry.line) && entry.line > 0,
      "La evidencia histórica no tiene una ubicación concreta.");
    const file = entry.file;
    requireCondition(file.length <= 4096 && !/[\\:\p{Cc}\p{Cf}]/u.test(file) &&
      !file.startsWith("~") && file.split("/").every(part => part !== "" && part !== "." && part !== ".."),
      "La evidencia histórica contiene una ruta no canónica.");
    paths.add(file);
  }
  requireCondition(paths.size <= MAX_PATHS, "La revalidación focalizada excede el máximo de 16 archivos; requiere revisión de alcance.");
  const sink = [...trace].reverse().find(entry => record(entry) && entry.kind === "sink");
  const location = sink ?? trace[0];
  requireCondition(record(location) && typeof location.file === "string", "No existe una ubicación original verificable.");
  return { findingPath: location.file, paths: [...paths].sort() };
}

export interface FocusedRevalidationPlan {
  mode: "focused_revalidation";
  auditRunId: string;
  fingerprint: string;
  remediationExecutionRunId: string;
  remediationFinishedAt: string;
  projectPath: string;
  scope: SecurityAuditScope;
  findingPath: string;
  originalRecordSha256: string;
  originalFileSha256: string;
  currentFileSha256: string;
  currentSnapshotSha256: string;
  budget: typeof FOCUSED_REVALIDATION_BUDGET;
  verifiers: [SecurityAuditRosterEntry, SecurityAuditRosterEntry];
  executionPolicy: "source-only";
  fullAudit: false;
}

/** Read-only preflight. No agent invocations, audit directories, or DB mutations.
 * Intended for both the operator preview and a future runner's admission gate.
 * The runner must recompute the plan, never trust the preview from the client. */
export async function prepareFocusedRevalidation(input: {
  db: DatabaseSync;
  getExecution: (runId: string) => ExecutionSnapshot | null;
  roster: readonly SecurityAuditRosterEntry[];
  auditRunId: string;
  fingerprint: string;
}): Promise<FocusedRevalidationPlan> {
  const {db, auditRunId, fingerprint} = input;
  requireCondition(RUN_ID.test(auditRunId) && FINGERPRINT.test(fingerprint), "Identificador o fingerprint inválido.");
  const original = getSecurityAuditRun(db, auditRunId);
  requireCondition(original && original.intent === "full_audit" && original.runStatus !== "in_progress" &&
    original.finishedAt && original.ledgerValidator === "pass" && original.findingsValidator === "pass",
    "Se exige una auditoría original terminal con ambos validadores aprobados.");
  const finding = listSecurityAuditFindings(db, auditRunId).find(row => row.fingerprint === fingerprint);
  requireCondition(finding?.verdict === "confirmed", "El fingerprint no es un hallazgo confirmado activo.");
  const remediation = listSecurityAuditRemediations(db, auditRunId).find(row => row.fingerprint === fingerprint);
  requireCondition(remediation?.executionRunId && remediation.state === "in_progress",
    "No existe una remediación pendiente de revalidación para este hallazgo.");
  const execution = input.getExecution(remediation.executionRunId)?.run;
  const link = execution?.configurationSnapshot?.securityRemediation;
  requireCondition(execution?.id === remediation.executionRunId && execution.status === "succeeded" &&
    execution.projectPath === original.projectPath && execution.finishedAt &&
    Number.isFinite(Date.parse(execution.finishedAt)) && Date.parse(execution.finishedAt) > Date.parse(original.finishedAt) &&
    link?.auditRunId === auditRunId && Array.isArray(link.fingerprints) && link.fingerprints.includes(fingerprint),
    "La ejecución vinculada no acredita una remediación exitosa posterior del mismo hallazgo y proyecto.");

  const layout = resolveSecurityAuditRunDirectory(auditRunId, original.projectPath);
  const metadata: unknown = JSON.parse(readSecurityAuditArtifact(layout, "run-metadata.json"));
  requireCondition(record(metadata) && metadata.runId === auditRunId && metadata.target === original.projectPath &&
    metadata.sourceRef === original.sourceRef && metadata.sourceDirty === original.sourceDirty &&
    metadata.run_status === original.runStatus,
    "La metadata original no coincide con la auditoría persistida.");
  // Recheck the official artifacts before relying on their projection.
  const published: unknown = JSON.parse(readSecurityAuditArtifact(layout, "findings.json"));
  readSecurityAuditArtifact(layout, "coverage-ledger.json");
  requireCondition(Array.isArray(published), "El artefacto de hallazgos original es inválido.");
  const matching = published.filter(entry => record(entry) && entry.fingerprint === fingerprint);
  const originalRecordSha256 = sha(finding.payload);
  requireCondition(matching.length === 1 && sha(matching[0]) === originalRecordSha256,
    "El hallazgo persistido no coincide exactamente con su artefacto oficial.");
  requireCondition(validateFindingsFile(layout.paths["findings.json"], layout.runDir).status === "PASS" &&
    validateCoverageLedgerFile(layout.paths["coverage-ledger.json"], layout.runDir).status === "PASS",
    "Los artefactos originales no superan la revalidación de sus validadores.");

  const {findingPath, paths} = focusedFindingPaths(finding.payload);
  const previous = readSecurityAuditSourceSnapshot(layout);
  const originalFiles = previous?.files.filter(file => file.path === findingPath) ?? [];
  requireCondition(originalFiles.length === 1, "No se conserva una captura original inequívoca de la ruta del hallazgo.");
  const scope: SecurityAuditScope = {kind:"component", scopePaths:paths, domains:[]};
  const resolved = await resolveSecurityAuditScopeFiles(original.projectPath, scope, {maxFiles:MAX_PATHS});
  requireCondition(resolved.root === original.projectPath &&
    JSON.stringify(resolved.scopeFiles) === JSON.stringify(paths),
    "El alcance histórico no coincide con archivos regulares canónicos del proyecto.");
  const current = await snapshotSecurityAuditScope(resolved);
  const currentFile = current.files.find(file => file.path === findingPath);
  requireCondition(currentFile && currentFile.sha256 !== originalFiles[0]!.sha256,
    "El archivo del hallazgo no cambió respecto de la auditoría original.");

  // Require two configured, distinct specialists with different engines;
  // no global model change, fallback to premium, or invented provenance.
  const reviewer = input.roster.find(entry => entry.agentId === "reviewer");
  const build = input.roster.find(entry => entry.agentId === "build");
  requireCondition(reviewer && build && reviewer.engine !== build.engine &&
    [reviewer.engine,build.engine].every(engine => engine === "claude" || engine === "opencode") &&
    reviewer.modelId.trim() && build.modelId.trim(),
    "La revalidación focalizada exige Revisor y Build habilitados en motores distintos.");
  return {
    mode:"focused_revalidation", auditRunId, fingerprint,
    remediationExecutionRunId:execution.id, remediationFinishedAt:execution.finishedAt,
    projectPath:original.projectPath, scope, findingPath, originalRecordSha256,
    originalFileSha256:originalFiles[0]!.sha256, currentFileSha256:currentFile.sha256,
    currentSnapshotSha256:current.sha256, budget:FOCUSED_REVALIDATION_BUDGET,
    verifiers:[{agentId:reviewer.agentId,engine:reviewer.engine,modelId:reviewer.modelId},
      {agentId:build.agentId,engine:build.engine,modelId:build.modelId}], executionPolicy:"source-only", fullAudit:false,
  };
}

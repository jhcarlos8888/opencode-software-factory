import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { getSecurityAuditRun, initializeSecurityAuditSchema } from "./security-audit-persistence.js";
import { runSecurityAuditOrchestrator, type SecurityAuditAgentInvoker, type SecurityAuditInvocationRequest, type SecurityAuditInvocationResult, type SecurityAuditOrchestratorConfig, type SecurityAuditRosterEntry } from "./security-audit-orchestrator.js";
import { resolveSecurityAuditRunDirectory } from "./security-audit-artifacts.js";
import { resolveSecurityAuditScopeFiles } from "./security-audit-scope.js";
import {
  SecurityAuditSourceError,
  defaultSecurityAuditSourceInspector,
  resolveSecurityAuditGitDiffScope,
  resolveSecurityAuditSource,
} from "./security-audit-source.js";
import { SecurityAuditStartOptionsError, validateSecurityAuditStartOptions } from "./security-audit-start.js";

const isolated = mkdtempSync(join(tmpdir(), "factory-security-audit-source-"));
const previousStateDir = process.env.FACTORY_STATE_DIR;
process.env.FACTORY_STATE_DIR = isolated;

after(() => {
  db.close();
  if (previousStateDir === undefined) delete process.env.FACTORY_STATE_DIR;
  else process.env.FACTORY_STATE_DIR = previousStateDir;
  rmSync(isolated, { recursive: true, force: true });
  for (const repo of repos) rmSync(repo, { recursive: true, force: true });
});

/** Repos Git temporales creados para las pruebas (sin push, solo local). */
const repos: string[] = [];

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["--no-pager", "-C", dir, ...args], { encoding: "utf8" });
}

function createGitRepo(name: string, files: Record<string, string>): string {
  const repo = mkdtempSync(join(tmpdir(), `factory-git-${name}-`));
  repos.push(repo);
  for (const [relative, content] of Object.entries(files)) {
    mkdirSync(join(repo, relative, ".."), { recursive: true });
    writeFileSync(join(repo, relative), content);
  }
  git(repo, ["init", "--quiet"]);
  git(repo, ["config", "user.email", "audit@example.com"]);
  git(repo, ["config", "user.name", "Audit Tests"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "--quiet", "-m", "base"]);
  return repo;
}

function headSha(repo: string, ref = "HEAD"): string {
  return git(repo, ["rev-parse", ref]).trim();
}

function writeAndCommit(repo: string, files: Record<string, string>, message: string): void {
  for (const [relative, content] of Object.entries(files)) {
    mkdirSync(join(repo, relative, ".."), { recursive: true });
    writeFileSync(join(repo, relative), content);
  }
  git(repo, ["add", "."]);
  git(repo, ["commit", "--quiet", "-m", message]);
}

function assertSourceError(error: unknown, code: string): SecurityAuditSourceError {
  assert.ok(error instanceof SecurityAuditSourceError, `error ${code} esperado: ${String(error)}`);
  assert.equal((error as SecurityAuditSourceError).code, code);
  return error as SecurityAuditSourceError;
}

// ---------------------------------------------------------------------------
// Procedencia del origen (top-level / HEAD / dirty reales)
// ---------------------------------------------------------------------------

test("resolveSecurityAuditSource resolves real top-level, HEAD and dirty state", async () => {
  const repo = createGitRepo("origen", { "src/handler.ts": "export const h = 1;\n" });
  const resolution = await resolveSecurityAuditSource(repo);
  assert.equal(resolution.kind, "git");
  assert.equal(resolution.sourceRef, headSha(repo), "sourceRef es el SHA completo de HEAD");
  assert.equal(resolution.headSha, resolution.sourceRef);
  assert.equal(resolution.sourceDirty, false, "worktree limpio");
  assert.equal(resolution.repoTopLevel, repo.replace(/\/+$/, "") || resolution.repoTopLevel);
  assert.ok(resolution.evidence.length > 0, "hay evidencia local");

  // Dirty real: untracked incluido.
  writeFileSync(join(repo, "nuevo-untracked.txt"), "untracked\n");
  const dirtyUntracked = await resolveSecurityAuditSource(repo);
  assert.equal(dirtyUntracked.sourceDirty, true, "porcelain incluye untracked");
  assert.equal(dirtyUntracked.sourceRef, headSha(repo));

  // Dirty real: modificación tracked.
  writeAndCommit(repo, { "src/other.ts": "export const o = 2;\n" }, "segundo");
  writeFileSync(join(repo, "src/handler.ts"), "export const h = 2;\n");
  const dirtyTracked = await resolveSecurityAuditSource(repo);
  assert.equal(dirtyTracked.sourceDirty, true);
  const cleanAfter = await resolveSecurityAuditSource(repo);
  void cleanAfter;
  git(repo, ["add", "."]);
  git(repo, ["commit", "--quiet", "-m", "cambio tracked"]);
  const clean = await resolveSecurityAuditSource(repo);
  assert.equal(clean.sourceDirty, false);
  assert.equal(clean.sourceRef, headSha(repo));
});

test("non-Git targets are a valid current source with sourceRef null and local evidence", async () => {
  const plain = mkdtempSync(join(tmpdir(), "factory-nogit-"));
  repos.push(plain);
  mkdirSync(join(plain, "src"), { recursive: true });
  writeFileSync(join(plain, "src/index.ts"), "export const i = 1;\n");
  const resolution = await resolveSecurityAuditSource(plain);
  assert.equal(resolution.kind, "non-git");
  assert.equal(resolution.sourceRef, null, "sin Git no hay sourceRef");
  assert.equal(resolution.sourceDirty, false);
  assert.equal(resolution.repoTopLevel, null);
  assert.ok(resolution.evidence.some((line) => line.includes("rev-parse --show-toplevel")),
    "la evidencia local describe el fallo de git");
});

// ---------------------------------------------------------------------------
// git-diff: refs seguras, worktree igual al head y scope real del diff
// ---------------------------------------------------------------------------

test("git-diff resolves full commits, real ACMR paths and head SHA as sourceRef", async () => {
  const repo = createGitRepo("diff", {
    "src/handler.ts": "export const h = 1;\n",
    "src/util.ts": "export const u = 1;\n",
    "docs/readme.md": "doc\n",
  });
  writeAndCommit(repo, {
    "src/handler.ts": "export const h = 2;\n",
    "src/new.ts": "export const n = 1;\n",
  }, "cambio");
  const base = headSha(repo, "HEAD~1");
  const head = headSha(repo);

  const diff = await resolveSecurityAuditGitDiffScope({
    projectPath: repo,
    baseRef: "HEAD~1",
    headRef: "HEAD",
    declaredPaths: [],
  });
  assert.equal(diff.baseSha, base, "base resuelta a commit completo");
  assert.equal(diff.headSha, head, "head resuelto a commit completo");
  assert.equal(diff.sourceRef, head, "sourceRef del diff es el SHA real del head");
  assert.equal(diff.sourceDirty, false);
  assert.deepEqual(diff.scopePaths, ["src/handler.ts", "src/new.ts"]);
  // El scope helper exige ficheros regulares reales en el HEAD actual.
  const scope = await resolveSecurityAuditScopeFiles(repo, {
    kind: "git-diff",
    scopePaths: diff.scopePaths,
    domains: [],
  });
  assert.deepEqual(scope.scopeFiles, diff.scopePaths);
});

test("git-diff intersects declared scope_paths and never widens them", async () => {
  const repo = createGitRepo("diff-acoto", {
    "src/handler.ts": "export const h = 1;\n",
    "src/util.ts": "export const u = 1;\n",
    "docs/readme.md": "doc\n",
  });
  writeAndCommit(repo, {
    "src/handler.ts": "export const h = 2;\n",
    "docs/readme.md": "doc actualizada\n",
  }, "cambio");

  const all = await resolveSecurityAuditGitDiffScope({
    projectPath: repo, baseRef: "HEAD~1", headRef: "HEAD", declaredPaths: [],
  });
  assert.deepEqual(all.scopePaths, ["docs/readme.md", "src/handler.ts"]);

  const narrowed = await resolveSecurityAuditGitDiffScope({
    projectPath: repo, baseRef: "HEAD~1", headRef: "HEAD", declaredPaths: ["src"],
  });
  assert.deepEqual(narrowed.scopePaths, ["src/handler.ts"],
    "el alcance definitivo es la intersección, jamás el diff completo");

  const exactFile = await resolveSecurityAuditGitDiffScope({
    projectPath: repo, baseRef: "HEAD~1", headRef: "HEAD", declaredPaths: ["src/handler.ts"],
  });
  assert.deepEqual(exactFile.scopePaths, ["src/handler.ts"]);

  const empty = await resolveSecurityAuditGitDiffScope({
    projectPath: repo, baseRef: "HEAD~1", headRef: "HEAD", declaredPaths: ["docs/subdir"],
  }).catch((error: unknown) => error);
  assertSourceError(empty, "git_diff_scope_empty");
});

test("git-diff rejects injected options: refs are parsed as revisions only", async () => {
  const repo = createGitRepo("diff-injection", { "src/handler.ts": "export const h = 1;\n" });
  const injectionPath = join(tmpdir(), "factory-injection-f10-proof");
  rmSync(injectionPath, { force: true });
  const error = await resolveSecurityAuditGitDiffScope({
    projectPath: repo,
    baseRef: `--output=${injectionPath}`,
    headRef: "HEAD",
    declaredPaths: [],
  }).catch((caught: unknown) => caught);
  assertSourceError(error, "git_diff_unresolved");
  assert.equal(existsSync(injectionPath), false,
    "la referencia inyectada NUNCA se ejecutó como opción de git");
});

test("git-diff requires the resolved headRef to be the current HEAD", async () => {
  const repo = createGitRepo("diff-head", { "src/handler.ts": "export const h = 1;\n" });
  writeAndCommit(repo, { "src/handler.ts": "export const h = 2;\n" }, "segundo");
  const error = await resolveSecurityAuditGitDiffScope({
    projectPath: repo, baseRef: "HEAD~1", headRef: "HEAD~1", declaredPaths: [],
  }).catch((caught: unknown) => caught);
  const sourceError = assertSourceError(error, "git_diff_worktree_mismatch");
  assert.match(sourceError.message, /HEAD actual/);
});

test("git-diff rejects a dirty worktree including untracked files", async () => {
  const repo = createGitRepo("diff-dirty", { "src/handler.ts": "export const h = 1;\n" });
  writeAndCommit(repo, { "src/handler.ts": "export const h = 2;\n" }, "segundo");
  writeFileSync(join(repo, "sin-commitear.txt"), "untracked\n");
  const errorUntracked = await resolveSecurityAuditGitDiffScope({
    projectPath: repo, baseRef: "HEAD~1", headRef: "HEAD", declaredPaths: [],
  }).catch((caught: unknown) => caught);
  assertSourceError(errorUntracked, "git_diff_worktree_mismatch");
  git(repo, ["add", "."]);
  git(repo, ["commit", "--quiet", "-m", "tercero"]);
  writeFileSync(join(repo, "src/handler.ts"), "export const h = 3;\n");
  const errorModified = await resolveSecurityAuditGitDiffScope({
    projectPath: repo, baseRef: "HEAD~2", headRef: "HEAD~1", declaredPaths: [],
  }).catch((caught: unknown) => caught);
  assertSourceError(errorModified, "git_diff_worktree_mismatch");
});

test("git-diff ACMR scope excludes deleted paths and refuses non-Git targets", async () => {
  const repo = createGitRepo("diff-borrados", {
    "src/handler.ts": "export const h = 1;\n",
    "src/deleted.ts": "export const d = 1;\n",
  });
  rmSync(join(repo, "src/deleted.ts"));
  writeFileSync(join(repo, "src/handler.ts"), "export const h = 2;\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "--quiet", "-m", "borrado"]);

  const diff = await resolveSecurityAuditGitDiffScope({
    projectPath: repo, baseRef: "HEAD~1", headRef: "HEAD", declaredPaths: [],
  });
  assert.deepEqual(diff.scopePaths, ["src/handler.ts"],
    "las rutas borradas no entran en el alcance (diff-filter ACMR y fichero real en HEAD)");

  const plain = mkdtempSync(join(tmpdir(), "factory-nogit-diff-"));
  repos.push(plain);
  const error = await resolveSecurityAuditGitDiffScope({
    projectPath: plain, baseRef: "HEAD~1", headRef: "HEAD", declaredPaths: [],
  }).catch((caught: unknown) => caught);
  assertSourceError(error, "git_diff_unresolved");
});

// ---------------------------------------------------------------------------
// Procedencia del servidor en el orquestador (el cliente nunca manda el origen)
// ---------------------------------------------------------------------------

const AGENT_IDS = [
  "architect", "build", "implementer", "reviewer", "tester", "reverse", "cloud-arbiter",
] as const;

function rosterFor(engine: SecurityAuditRosterEntry["engine"]): SecurityAuditRosterEntry[] {
  return AGENT_IDS.map((agentId) => ({
    agentId,
    engine,
    modelId: "opencode-go/mimo-v2.6-flash",
  }));
}

function baseConfig(repo: string, overrides: Partial<SecurityAuditOrchestratorConfig> = {}): SecurityAuditOrchestratorConfig {
  return {
    runId: `src-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    projectPath: repo,
    profile: "quick",
    intent: "full_audit",
    scope: { kind: "directory", scopePaths: ["src"] },
    budget: { maxInvocations: 12, maxConcurrency: 1, maxDurationMs: 600_000 },
    // Valores del "cliente": el orquestador debe IGNORARLOS y resolver los reales.
    sourceRef: "falso-cliente-ref",
    sourceDirty: true,
    roster: rosterFor("opencode"),
    priorRuns: [],
    ...overrides,
  };
}

const db = new DatabaseSync(join(isolated, "source.sqlite"));
initializeSecurityAuditSchema(db);

function assertResolvedProvenance(runId: string, expectedRef: string, expectedDirty: boolean): void {
  const row = getSecurityAuditRun(db, runId);
  assert.equal(row?.sourceRef, expectedRef, "la base persiste el sourceRef resuelto por el servidor");
  assert.equal(row?.sourceDirty, expectedDirty);
  const layout = resolveSecurityAuditRunDirectory(runId);
  const metadata = JSON.parse(readFileSync(layout.paths["run-metadata.json"], "utf8")) as Record<string, unknown>;
  assert.equal(metadata.sourceRef, expectedRef, "run-metadata.json publica el sourceRef resuelto");
  assert.equal(metadata.sourceDirty, expectedDirty);
}

test("the orchestrator persists the server-resolved origin and ignores client values", async () => {
  const repo = createGitRepo("orch-procedencia", { "src/handler.ts": "export const h = 1;\n" });
  // Presupuesto mínimo insuficiente: metadata + persistencia se escriben
  // ANTES del gate, así que la procedencia resuelta queda visible sin agentes.
  const config = baseConfig(repo, {
    budget: { maxInvocations: 5, maxConcurrency: 1, maxDurationMs: 600_000 },
  });
  const invoker: SecurityAuditAgentInvoker = {
    async invoke() {
      throw new Error("ningún agente debe invocarse antes del gate de presupuesto");
    },
  };
  const outcome = await runSecurityAuditOrchestrator(
    {
      db, invoker,
      log: () => {},
      isCancelled: () => false,
    },
    config,
  );
  assert.equal(outcome.status, "incomplete");
  assertResolvedProvenance(config.runId, headSha(repo), false);
});

test("resume refuses a changed source without mixing candidates or evidence", async () => {
  const repo = createGitRepo("orch-resume", { "src/handler.ts": "export const h = 1;\n" });
  const config = baseConfig(repo, {
    budget: { maxInvocations: 5, maxConcurrency: 1, maxDurationMs: 600_000 },
  });
  const noopInvoker: SecurityAuditAgentInvoker = {
    async invoke() {
      throw new Error("sin invocaciones en el run original");
    },
  };
  await runSecurityAuditOrchestrator(
    { db, invoker: noopInvoker, log: () => {}, isCancelled: () => false },
    config,
  );

  // La misma identidad reanuda sin error de procedencia (queda incomplete).
  const sameIdentity = await runSecurityAuditOrchestrator(
    { db, invoker: noopInvoker, log: () => {}, isCancelled: () => false },
    baseConfig(repo, { runId: "irrelevante-2", resumeRunId: config.runId }),
  );
  assert.equal(sameIdentity.status, "incomplete");
  assert.notEqual(sameIdentity.incompleteReason, null);

  // Dirty posterior (untracked, mismo HEAD) también rompe la identidad.
  writeFileSync(join(repo, "posterior.txt"), "untracked\n");
  const dirtyError = await runSecurityAuditOrchestrator(
    { db, invoker: noopInvoker, log: () => {}, isCancelled: () => false },
    baseConfig(repo, { runId: "irrelevante-3", resumeRunId: config.runId }),
  ).catch((error: unknown) => error);
  assert.ok(dirtyError instanceof Error);
  assert.match(dirtyError.message, /resume_source_changed/);
  assert.match(dirtyError.message, /dirty/);

  // Cambio de HEAD después del run original.
  git(repo, ["add", "."]);
  git(repo, ["commit", "--quiet", "-m", "cambio posterior"]);
  const movedHeadError = await runSecurityAuditOrchestrator(
    { db, invoker: noopInvoker, log: () => {}, isCancelled: () => false },
    baseConfig(repo, { runId: "irrelevante-4", resumeRunId: config.runId }),
  ).catch((error: unknown) => error);
  assert.ok(movedHeadError instanceof Error);
  assert.match(movedHeadError.message, /resume_source_changed/);
  assert.match(movedHeadError.message, /nueva auditoría/);
  const row = getSecurityAuditRun(db, config.runId);
  assert.equal(row?.sourceRef, headSha(repo, "HEAD~1"),
    "la identidad persistida del run original no se reescribe al reanudar");
});

// ---------------------------------------------------------------------------
// Alcance estricto: recon/hunter/crítico fuera del scope helper
// ---------------------------------------------------------------------------

function officialRecord(fingerprint: string) {
  return {
    verdict: "confirmed",
    fingerprint,
    title: "Comprobación de propiedad ausente",
    description: "Un atacante alcanza una operación sin la comprobación prevista.",
    root_cause: "handle omite la comprobación antes de cambiar el objeto.",
    intended_behavior: "Solo el propietario puede cambiar el objeto.",
    trace: [{ kind: "entrypoint", file: "src/handler.ts", line: 1, scope: "handle", description: "Entrada de atacante." }],
    evidence: [{ file: "src/handler.ts", line: 1, description: "Falta la comprobación requerida." }],
    conditions: [],
    execution: {
      attacker_perspective: "usuario remoto sin privilegios",
      payloads: ["identificador ajeno"],
      instructions: ["enviar el identificador"],
      observed_result: "el objeto ajeno cambia",
    },
    remediation: { strategy: "comprobar la propiedad antes del cambio" },
    severity: {
      likelihood: { score: "medium", reason: "operación directa" },
      impact: { score: "medium", reason: "cambio de un objeto protegido" },
      overall_severity: "medium",
    },
    confidence: { score: "high", reason: "ruta y resultado reproducidos" },
  };
}

test("recon surfaces and hunter paths outside the real scope are rejected", async () => {
  const repo = createGitRepo("orch-alcance", {
    "src/handler.ts": "export const h = 1;\n",
    "src/util.ts": "export const u = 1;\n",
  });
  const warnings: string[] = [];
  const invoker: SecurityAuditAgentInvoker = {
    async invoke(request: SecurityAuditInvocationRequest): Promise<SecurityAuditInvocationResult> {
      const base = {
        instanceId: request.instanceId,
        agentRunId: request.instanceId,
        agentId: request.agentId,
        engine: request.engine,
        modelId: request.modelId,
        sessionId: `session-${request.instanceId}`,
        handoffId: request.handoffId,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        fingerprint: request.fingerprint,
        crossEngineVerified: false,
        providerError: null,
      };
      if (request.phase === 1) {
        // JSON perfectamente válido con una superficie FUERA del alcance real.
        return {
          ...base,
          status: "succeeded" as const,
          output: JSON.stringify({
            surfaces: [
              { path: "src", boundary: "src#trust-boundary", subsystem: "src", attack_class: "ATTACK-CLASSES.md#Coverage" },
              { path: "fuera/evil.ts", boundary: "fuera#trust-boundary", subsystem: "fuera", attack_class: "ATTACK-CLASSES.md#Coverage" },
            ],
            prior_evidence: [],
            build_paths: [],
          }),
        };
      }
      if (request.phase === 2 && request.role === "hunter") {
        return {
          ...base,
          status: "succeeded" as const,
          output: JSON.stringify({
            unit_id: request.prompt.match(/Unidad de cobertura: (\S+)/)?.[1] ?? "",
            candidates: [{
              fingerprint: "fp-1",
              title: "Candidato real",
              description: "Frontera cruzada en la fuente.",
              location: "src/handler.ts:1",
              boundary: "frontera",
              impact: "lectura no autorizada",
            }],
            // Una ruta fuera del conjunto autorizado se rechaza.
            covered_paths: ["src/handler.ts", "src/util.ts", "fuera/evil.ts"],
            uncovered: [],
          }),
        };
      }
      if (request.phase === 2) {
        return {
          ...base,
          status: "succeeded" as const,
          output: JSON.stringify({ stop: true, missing_units: [], reassign_ids: [] }),
        };
      }
      const fingerprint = request.prompt.match(/Fingerprint: (\S+)/)?.[1] ?? "fp-1";
      return {
        ...base,
        status: "succeeded" as const,
        output: JSON.stringify({
          decision: "verified",
          fingerprint,
          reason: "verificación en la fuente",
          record: officialRecord(fingerprint),
          ...(request.prompt.includes("Perfil quick")
            ? { final_record_verification: { fingerprint, decision: "verified" } }
            : {}),
        }),
      };
    },
  };
  const config = baseConfig(repo, { runId: "orch-alcance-real" });
  const outcome = await runSecurityAuditOrchestrator(
    {
      db, invoker,
      log: (entry) => { if (entry.kind === "warning") warnings.push(entry.message); },
      isCancelled: () => false,
    },
    config,
  );
  assert.equal(outcome.status, "complete", JSON.stringify({
    completion: outcome.completion, pendingUnits: outcome.pendingUnits,
  }));
  const layout = resolveSecurityAuditRunDirectory(config.runId);
  const ledger = JSON.parse(readFileSync(layout.paths["coverage-ledger.json"], "utf8")) as Array<Record<string, unknown>>;
  const serialized = JSON.stringify(ledger);
  assert.equal(serialized.includes("fuera/evil.ts"), false,
    "ninguna unidad ni ruta del ledger incluye una superficie fuera del alcance real");
  assert.ok(
    warnings.some((message) => message.includes("fuera/evil.ts")),
    "las superficies/paths fuera de alcance se rechazan con aviso explícito",
  );
  // La unidad real queda cubierta SOLO con la evidencia autorizada.
  const srcUnit = ledger.find((unit) => unit.surface === "src");
  assert.equal(srcUnit?.status, "covered");
  assert.deepEqual(srcUnit?.reviewed_paths, ["src/handler.ts", "src/util.ts"]);
});

// ---------------------------------------------------------------------------
// validateStart: los campos de procedencia del cliente se rechazan SIEMPRE
// ---------------------------------------------------------------------------

test("validateStart rejects client-provided sourceRef/sourceDirty", () => {
  for (const [field, value] of [["sourceRef", "abc123"], ["sourceDirty", true]] as const) {
    const error = (() => {
      try {
        validateSecurityAuditStartOptions({
          profile: "quick",
          scope: { kind: "project" },
          [field]: value,
        });
        return null;
      } catch (caught) {
        return caught;
      }
    })();
    assert.ok(error instanceof SecurityAuditStartOptionsError, `${field} se rechaza`);
    assert.equal(error.code, "client_source_not_authoritative");
  }
});

test("the default inspector is the real one and DI remains explicit", async () => {
  const repo = createGitRepo("inspector", { "src/handler.ts": "export const h = 1;\n" });
  const resolution = await defaultSecurityAuditSourceInspector.resolveSource(repo);
  assert.equal(resolution.kind, "git");
  assert.equal(resolution.sourceRef, headSha(repo));
});

test("git-diff in a subdirectory preserves unicode and spaces, excluding sibling changes", async () => {
  const repo = createGitRepo("nested", { "app/a.ts": "a", "outside.ts": "old" });
  const base = headSha(repo);
  writeAndCommit(repo, { "app/a.ts": "b", "app/archivo con ñ.ts": "new", "outside.ts": "new" }, "nested changes");
  const result = await resolveSecurityAuditGitDiffScope({ projectPath: join(repo,"app"),
    baseRef: base, headRef: headSha(repo), declaredPaths: [] });
  assert.deepEqual(result.scopePaths, ["a.ts", "archivo con ñ.ts"]);
});

test("source-only provenance rejects configured executable Git filters", async () => {
  const repo = createGitRepo("filter", { "src/a.ts": "a" });
  git(repo, ["config", "filter.audit.clean", "cat"]);
  await assert.rejects(resolveSecurityAuditSource(repo), (error) => {
    assertSourceError(error, "git_unsafe_config");
    return true;
  });
});

test("resume rejects a dirty-to-dirty change even when HEAD and file names are identical", async () => {
  const repo = createGitRepo("dirty-to-dirty", { "src/handler.ts": "original" });
  writeFileSync(join(repo, "src/handler.ts"), "dirty first");
  const config = baseConfig(repo, {
    budget: { maxInvocations: 5, maxConcurrency: 1, maxDurationMs: 600_000 },
  });
  const deps = { db, invoker: { async invoke() { throw new Error("no model calls"); } },
    log: () => {}, isCancelled: () => false };
  await runSecurityAuditOrchestrator(deps, config);
  writeFileSync(join(repo, "src/handler.ts"), "dirty second");
  await assert.rejects(runSecurityAuditOrchestrator(deps,
    baseConfig(repo, { runId: "dirty-resume-attempt", resumeRunId: config.runId })), /resume_source_changed/);
});

import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import {
  SECURITY_AUDIT_SHARED_ARTIFACTS,
  SECURITY_AUDIT_INCOMPLETE_MARKER,
  assertSecurityAuditOutputOutsideTarget,
  createSecurityAuditAgentWorkspace,
  createSecurityAuditRunDirectory,
  declareSecurityAuditComplete,
  evaluateSecurityAuditCompletion,
  isSandboxAuthorizationValid,
  readSecurityAuditArtifact,
  resolveSecurityAuditRunDirectory,
  securityAuditsRoot,
  updateSecurityAuditRunMetadataStatus,
  seedSecurityAuditCoverageLedger,
  updateSecurityAuditCoverageLedger,
  writeSecurityAuditArchitecture,
  writeSecurityAuditFindings,
  writeSecurityAuditPhaseSixReports,
  writeSecurityAuditRunMetadata,
  type SecurityAuditRunMetadata,
} from "./security-audit-artifacts.js";

const FIXTURE_DIR = fileURLToPath(new URL("./test-fixtures/security-audit/", import.meta.url));
const isolatedRoot = mkdtempSync(join(tmpdir(), "factory-security-audit-artifacts-"));
const previousStateDir = process.env.FACTORY_STATE_DIR;
process.env.FACTORY_STATE_DIR = isolatedRoot;

after(() => {
  if (previousStateDir === undefined) delete process.env.FACTORY_STATE_DIR;
  else process.env.FACTORY_STATE_DIR = previousStateDir;
  rmSync(isolatedRoot, { recursive: true, force: true });
});

function validLedger(): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, "coverage-ledger-valid.json"), "utf8"));
}

function validFindings(): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, "findings-valid.json"), "utf8"));
}

function metadata(overrides: Partial<SecurityAuditRunMetadata> = {}): SecurityAuditRunMetadata {
  return {
    runId: "run-artifacts",
    repo: "example",
    target: "/srv/example",
    sourceRef: "abc123",
    sourceDirty: false,
    profile: "standard",
    scope: { kind: "project" },
    budget: null,
    executionPolicy: "source-only",
    selectedCompanions: ["WEB-PROTOCOL-AND-AUTH.md"],
    priorRunPaths: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("the default root is exact and FACTORY_STATE_DIR is respected for tests", () => {
  assert.equal(securityAuditsRoot(), join(isolatedRoot, "security-audits"));
  const saved = process.env.FACTORY_STATE_DIR;
  delete process.env.FACTORY_STATE_DIR;
  try {
    assert.equal(
      securityAuditsRoot(),
      join(homedir(), ".local", "state", "opencode-software-factory", "security-audits"),
    );
  } finally {
    process.env.FACTORY_STATE_DIR = saved;
  }
});

test("run directories are private, unique and free of symlinks", () => {
  const layout = createSecurityAuditRunDirectory("run-permisos");
  const rootInfo = lstatSync(layout.root);
  const runInfo = lstatSync(layout.runDir);
  assert.equal(rootInfo.isDirectory(), true);
  assert.equal(rootInfo.isSymbolicLink(), false);
  assert.equal(rootInfo.mode & 0o777, 0o700);
  assert.equal(runInfo.mode & 0o777, 0o700);
  assert.ok(layout.runDir.startsWith(layout.root + "/"));

  // Un id reutilizable no crea un segundo directorio.
  assert.throws(() => createSecurityAuditRunDirectory("run-permisos"), /ya existe/);
  const again = resolveSecurityAuditRunDirectory("run-permisos");
  assert.equal(again.runDir, layout.runDir);

  // Ids con traversal, absolutos o de dispositivo Windows se rechazan.
  assert.throws(() => createSecurityAuditRunDirectory("../fuera"), /inválido/);
  assert.throws(() => createSecurityAuditRunDirectory("/absoluto"), /inválido/);
  assert.throws(() => createSecurityAuditRunDirectory("con"), /inválido/);
  assert.throws(() => createSecurityAuditRunDirectory("Run-MAYUSCULAS"), /inválido/);
});

test("output directories outside the target, its git metadata and sensitive home", () => {
  const target = mkdtempSync(join(tmpdir(), "factory-security-audit-target-"));
  try {
    mkdirSync(join(target, ".git"), { recursive: true });
    const layout = createSecurityAuditRunDirectory("run-alcance");
    // Directorio de salida legítimo: bajo la raíz de la fábrica, fuera del target.
    assert.doesNotThrow(() => assertSecurityAuditOutputOutsideTarget(layout, target));

    const insideTarget = {
      ...layout,
      runDir: join(target, "security-audits", "run-x"),
      agentsRoot: join(target, "security-audits", "run-x", "agents"),
    };
    assert.throws(
      () => assertSecurityAuditOutputOutsideTarget(insideTarget, target),
      /dentro del target/,
    );

    const insideGit = {
      ...layout,
      runDir: join(target, ".git", "run-x"),
      agentsRoot: join(target, ".git", "run-x", "agents"),
    };
    assert.throws(
      () => assertSecurityAuditOutputOutsideTarget(insideGit, target),
      /dentro del target/,
    );

    const insideSensitiveHome = {
      ...layout,
      runDir: join(homedir(), ".ssh", "run-x"),
      agentsRoot: join(homedir(), ".ssh", "run-x", "agents"),
    };
    assert.throws(
      () => assertSecurityAuditOutputOutsideTarget(insideSensitiveHome, target),
      /home sensible/,
    );

    assert.throws(
      () => assertSecurityAuditOutputOutsideTarget(layout, "ruta/relativa"),
      /absoluta/,
    );
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("shared artifacts are written atomically with 0600 and secret redaction", () => {
  const layout = createSecurityAuditRunDirectory("run-escritura");
  writeSecurityAuditArchitecture(
    layout,
    "# Arquitectura\n\napi_key=SECRETOQUEFUGA999 y password: hunter2\n",
  );
  const content = readSecurityAuditArtifact(layout, "architecture.md");
  assert.equal(content.includes("SECRETOQUEFUGA999"), false);
  assert.equal(content.includes("hunter2"), false);
  assert.match(content, /\[REDACTED\]/);
  assert.equal(lstatSync(layout.paths["architecture.md"]).mode & 0o777, 0o600);
  assert.equal(lstatSync(layout.paths["architecture.md"]).isSymbolicLink(), false);

  assert.throws(() => writeSecurityAuditArchitecture(layout, "   "), /vacío/);
  assert.throws(
    () => readSecurityAuditArtifact(layout, "arquivo-desconocido.json" as Parameters<typeof readSecurityAuditArtifact>[1]),
    /Artefacto compartido no permitido/,
  );

  // Un symlink como destino jamás se sigue.
  const outside = mkdtempSync(join(tmpdir(), "factory-security-audit-outside-"));
  try {
    const secret = join(outside, "secret.txt");
    writeFileSync(secret, "NO-TOCAR", { mode: 0o600 });
    const linkTarget = join(layout.runDir, "architecture.md");
    rmSync(linkTarget);
    symlinkSync(secret, linkTarget);
    assert.throws(() => writeSecurityAuditArchitecture(layout, "# nuevo"), /symlink/);
    assert.equal(readFileSync(secret, "utf8"), "NO-TOCAR");
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("run metadata is source-only: the sandboxed policy is always rejected (F08)", () => {
  const layout = createSecurityAuditRunDirectory("run-metadata");

  writeSecurityAuditRunMetadata(layout, metadata());
  const stored = JSON.parse(readSecurityAuditArtifact(layout, "run-metadata.json"));
  assert.equal(stored.execution_policy, "source-only");

  // F08: la política sandboxed se rechaza SIEMPRE (sin autorización...).
  assert.throws(
    () =>
      writeSecurityAuditRunMetadata(
        layout,
        metadata({
          executionPolicy: "sandboxed-source-and-local-only",
          sandboxAuthorization: null,
        }),
      ),
    /sandbox_not_implemented/,
  );
  // ...y también con una autorización que cumpliría los criterios formales:
  // sin ejecución sandboxed implementada no hay metadata sandboxed.
  assert.throws(
    () =>
      writeSecurityAuditRunMetadata(
        layout,
        metadata({
          executionPolicy: "sandboxed-source-and-local-only",
          sandboxAuthorization: {
            available: true,
            isolationClaim: "partial",
            blockers: ["disk_limit_unavailable", "promotion_dirfd_unavailable"],
            networkTarget: "denied",
          },
        }),
      ),
    /sandbox_not_implemented/,
  );
  // La sonda de criterios sigue existiendo como limitación documentada del
  // módulo sandbox (hoy sin llamador productivo).
  assert.equal(
    isSandboxAuthorizationValid({
      available: false,
      isolationClaim: "partial",
      blockers: [],
      networkTarget: "denied",
    }),
    false,
  );
  assert.equal(
    isSandboxAuthorizationValid({
      available: true,
      isolationClaim: "none",
      blockers: [],
      networkTarget: "denied",
    }),
    false,
  );
  assert.equal(
    isSandboxAuthorizationValid({
      available: true,
      isolationClaim: "partial",
      blockers: ["disk_limit_unavailable", "promotion_dirfd_unavailable"],
      networkTarget: "denied",
    }),
    true,
  );
  // La metadata publicada permanece source-only e intacta tras los rechazos.
  const republished = JSON.parse(readSecurityAuditArtifact(layout, "run-metadata.json"));
  assert.equal(republished.execution_policy, "source-only");
  assert.equal("sandboxAuthorization" in republished, false);
});

test("Paquete 7: run-metadata.json persiste la instrucción efectiva del operador", () => {
  const layout = createSecurityAuditRunDirectory("run-metadata-instruccion");

  writeSecurityAuditRunMetadata(layout, metadata({
    instructions: "Prioriza la superficie de autenticación y revisa los tokens de sesión.",
  }));
  const stored = JSON.parse(readSecurityAuditArtifact(layout, "run-metadata.json")) as Record<string, unknown>;
  assert.equal(
    stored.instructions,
    "Prioriza la superficie de autenticación y revisa los tokens de sesión.",
    "la instrucción efectiva queda publicada en el campo propio del run",
  );
  assert.equal(stored.execution_policy, "source-only");

  // Sin instrucción registrada: cadena vacía honesta (nunca texto inventado).
  const emptyLayout = createSecurityAuditRunDirectory("run-metadata-sin-instruccion");
  writeSecurityAuditRunMetadata(emptyLayout, metadata());
  const empty = JSON.parse(readSecurityAuditArtifact(emptyLayout, "run-metadata.json")) as Record<string, unknown>;
  assert.equal(empty.instructions, "");

  // La actualización de estado terminal conserva la instrucción persistida.
  updateSecurityAuditRunMetadataStatus(layout, { runStatus: "incomplete", incompleteReason: "deadline_exceeded" });
  const after = JSON.parse(readSecurityAuditArtifact(layout, "run-metadata.json")) as Record<string, unknown>;
  assert.equal(
    after.instructions,
    "Prioriza la superficie de autenticación y revisa los tokens de sesión.",
    "el cierre no borra la instrucción del run",
  );
});

test("ledger and findings are validated by the official validators on every write", () => {
  const layout = createSecurityAuditRunDirectory("run-validacion");

  const seeded = seedSecurityAuditCoverageLedger(layout, validLedger());
  assert.equal(seeded.status, "PASS");
  assert.ok(existsSync(layout.paths["coverage-ledger.json"]));

  assert.throws(
    () =>
      seedSecurityAuditCoverageLedger(
        layout,
        JSON.parse(readFileSync(join(FIXTURE_DIR, "coverage-ledger-invalid.json"), "utf8")),
      ),
    /validador oficial rechaz/,
  );

  const previous = readSecurityAuditArtifact(layout, "coverage-ledger.json");
  assert.throws(
    () =>
      updateSecurityAuditCoverageLedger(layout, [
        { coverage_id: "roto", status: "no-existe" },
      ]),
    /validador oficial rechaz/,
  );
  // La actualización fallida no publica nada: el archivo anterior se conserva.
  assert.equal(readSecurityAuditArtifact(layout, "coverage-ledger.json"), previous);

  const updated = updateSecurityAuditCoverageLedger(layout, validLedger());
  assert.equal(updated.status, "PASS");

  const findings = writeSecurityAuditFindings(layout, validFindings());
  assert.equal(findings.status, "PASS");
  const previousFindings = readSecurityAuditArtifact(layout, "findings.json");
  assert.throws(() => writeSecurityAuditFindings(layout, [{ verdict: "confirmed" }]), /rechaz/);
  assert.equal(readSecurityAuditArtifact(layout, "findings.json"), previousFindings);
});

test("phase six reports are complete only with the official marker when incomplete", () => {
  const layout = createSecurityAuditRunDirectory("run-informes");
  const reports = {
    report: "# Informe\n\nSin hallazgos confirmados.\n",
    detail: "# Detalle\n",
    needsValidation: "# Necesita validación\n",
  };
  writeSecurityAuditPhaseSixReports(layout, reports, { incomplete: false });
  for (const name of ["REPORT.md", "FINDINGS-DETAIL.md", "NEEDS-VALIDATION.md"] as const) {
    assert.ok(existsSync(layout.paths[name]));
    assert.equal(lstatSync(layout.paths[name]).mode & 0o777, 0o600);
  }

  assert.throws(
    () => writeSecurityAuditPhaseSixReports(layout, reports, { incomplete: true }),
    new RegExp(SECURITY_AUDIT_INCOMPLETE_MARKER),
  );
  writeSecurityAuditPhaseSixReports(
    layout,
    { ...reports, report: `# Informe\n\n${SECURITY_AUDIT_INCOMPLETE_MARKER}: presupuesto agotado.\n` },
    { incomplete: true, incompleteReason: "validation_budget_exhausted" },
  );
  assert.match(
    readSecurityAuditArtifact(layout, "REPORT.md"),
    new RegExp(SECURITY_AUDIT_INCOMPLETE_MARKER),
  );
});

test("complete requires seven artifacts, both validators, six phases and no pending candidates", () => {
  const layout = createSecurityAuditRunDirectory("run-completo");
  const phases = [1, 2, 3, 4, 5, 6];

  const early = evaluateSecurityAuditCompletion(layout, {
    phasesComplete: [],
    ledgerValidator: "pending",
    findingsValidator: "pending",
    unvalidatedCandidates: [],
  });
  assert.equal(early.complete, false);
  assert.ok(early.missing.includes("artifact:run-metadata.json"));
  assert.ok(early.missing.includes("phase:1"));
  assert.ok(early.missing.includes("validator:findings"));

  writeSecurityAuditRunMetadata(layout, metadata());
  writeSecurityAuditArchitecture(layout, "# Arquitectura\n");
  seedSecurityAuditCoverageLedger(layout, validLedger());
  writeSecurityAuditFindings(layout, validFindings());
  writeSecurityAuditPhaseSixReports(
    layout,
    {
      report: `# Informe\n\n${SECURITY_AUDIT_INCOMPLETE_MARKER}: candidatos pendientes.\n`,
      detail: "# Detalle\n",
      needsValidation: "# NV\n",
    },
    { incomplete: true },
  );

  const withPending = evaluateSecurityAuditCompletion(layout, {
    phasesComplete: phases,
    ledgerValidator: "pass",
    findingsValidator: "pass",
    unvalidatedCandidates: ["src-parser-size-hypothesis"],
  });
  assert.equal(withPending.complete, false);
  assert.deepEqual(withPending.missing, ["unvalidated:src-parser-size-hypothesis"]);
  assert.throws(
    () =>
      declareSecurityAuditComplete(layout, {
        phasesComplete: phases,
        ledgerValidator: "pass",
        findingsValidator: "pass",
        unvalidatedCandidates: ["src-parser-size-hypothesis"],
      }),
    /unvalidated:src-parser-size-hypothesis/,
  );

  const complete = declareSecurityAuditComplete(layout, {
    phasesComplete: phases,
    ledgerValidator: "pass",
    findingsValidator: "pass",
    unvalidatedCandidates: [],
  });
  assert.equal(complete.complete, true);
  assert.deepEqual(complete.missing, []);
  assert.deepEqual([...SECURITY_AUDIT_SHARED_ARTIFACTS].sort(), [
    "FINDINGS-DETAIL.md",
    "NEEDS-VALIDATION.md",
    "REPORT.md",
    "architecture.md",
    "coverage-ledger.json",
    "findings.json",
    "run-metadata.json",
  ]);
});

test("agent workspaces are isolated from the shared artifacts", () => {
  const layout = createSecurityAuditRunDirectory("run-agentes");
  const workspace = createSecurityAuditAgentWorkspace(layout, "hunter-1");
  assert.ok(workspace.scratchDir.startsWith(workspace.agentDir));
  assert.ok(workspace.artifactsDir.startsWith(workspace.agentDir));
  assert.equal(workspace.scratchDir.includes("coverage-ledger.json"), false);
  for (const shared of Object.values(layout.paths)) {
    assert.equal(shared.startsWith(workspace.agentDir), false);
  }
  assert.equal(lstatSync(workspace.scratchDir).mode & 0o777, 0o700);
  assert.equal(lstatSync(workspace.artifactsDir).mode & 0o777, 0o700);

  assert.throws(() => createSecurityAuditAgentWorkspace(layout, "hunter-1"), /ya existe/);
  assert.throws(() => createSecurityAuditAgentWorkspace(layout, "../fuga"), /inválido/);
  assert.throws(() => createSecurityAuditAgentWorkspace(layout, "CON"), /inválido/);
});

test("production output guard refuses nested state before creating anything, including aliases", () => {
  const target = mkdtempSync(join(tmpdir(), "factory-output-target-"));
  const saved = process.env.FACTORY_STATE_DIR;
  const alias = join(isolatedRoot, "target-alias");
  try {
    process.env.FACTORY_STATE_DIR = join(target, "forbidden-state");
    assert.throws(() => createSecurityAuditRunDirectory("run-inside", target));
    assert.equal(existsSync(join(target, "forbidden-state")), false);
    symlinkSync(target, alias);
    assert.throws(() => createSecurityAuditRunDirectory("run-alias", alias));
    process.env.FACTORY_STATE_DIR = join(alias, "forbidden-state");
    assert.throws(() => createSecurityAuditRunDirectory("run-link", target));
    assert.equal(existsSync(join(target, "forbidden-state")), false);
  } finally {
    process.env.FACTORY_STATE_DIR = saved;
    rmSync(alias, { force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("completion refuses an empty artifact or symlink instead of trusting its existence", () => {
  const layout = createSecurityAuditRunDirectory("run-unsafe-completion");
  for (const name of SECURITY_AUDIT_SHARED_ARTIFACTS) writeFileSync(layout.paths[name], "fixture");
  const input = { phasesComplete: [1,2,3,4,5,6], ledgerValidator: "pass" as const,
    findingsValidator: "pass" as const, unvalidatedCandidates: [] };
  assert.equal(evaluateSecurityAuditCompletion(layout, input).complete, true);
  writeFileSync(layout.paths["findings.json"], "");
  assert.equal(evaluateSecurityAuditCompletion(layout, input).complete, false);
  rmSync(layout.paths["findings.json"]);
  symlinkSync(layout.paths["coverage-ledger.json"], layout.paths["findings.json"]);
  assert.equal(evaluateSecurityAuditCompletion(layout, input).complete, false);
  assert.throws(() => readSecurityAuditArtifact(layout, "findings.json"));
});

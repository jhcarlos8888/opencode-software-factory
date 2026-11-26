import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  priorStartingPathsForSurface,
  resolveSecurityAuditScopeFiles,
  snapshotSecurityAuditScope,
  SECURITY_AUDIT_SCOPE_MAX_FILES,
  SecurityAuditScopeError,
  startingPathsForScopePath,
} from "./security-audit-scope.js";
import {
  seedSecurityAuditLedger,
  type SecurityAuditLedgerUnit,
  type SecurityAuditOrchestratorConfig,
} from "./security-audit-orchestrator.js";
import {
  validateCoverageLedgerFile,
  type SecurityAuditUpstreamResult,
} from "./security-audit-upstream.js";

const fixtures: string[] = [];

after(() => {
  for (const fixture of fixtures) rmSync(fixture, { recursive: true, force: true });
});

/**
 * Target REAL de pruebas con ficheros regulares sembrables y contenido que la
 * resolución debe excluir (.git, node_modules, secretos) o no seguir
 * (symlinks hacia fuera del target).
 */
function makeProjectFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "factory-scope-target-"));
  fixtures.push(root);
  mkdirSync(join(root, "src", "api"), { recursive: true });
  mkdirSync(join(root, "src", "lib"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  // Directorio real sin ficheros elegibles (para el caso "sin contenido").
  mkdirSync(join(root, "vacio"), { recursive: true });
  writeFileSync(join(root, "README.md"), "readme\n");
  writeFileSync(join(root, "docs", "guide.md"), "guía\n");
  writeFileSync(join(root, "src", "api", "handler.ts"), "export const handle = () => 1;\n");
  writeFileSync(join(root, "src", "api", "util.ts"), "export const util = () => 2;\n");
  writeFileSync(join(root, "src", "lib", "index.ts"), "export const lib = () => 3;\n");
  // Excluidos: VCS, dependencias, secretos y nombres sensibles.
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(root, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
  writeFileSync(join(root, ".env"), "SECRET=1\n");
  writeFileSync(join(root, ".env.local"), "SECRET=2\n");
  writeFileSync(join(root, "server.key"), "-----BEGIN KEY-----\n");
  mkdirSync(join(root, "secrets"), { recursive: true });
  writeFileSync(join(root, "secrets", "token.txt"), "token\n");
  writeFileSync(join(root, "credentials.json"), "{}\n");
  // Symlinks: nunca se siguen ni se incluyen.
  const outsideFile = join(root, "..", `${root.split("/").pop()}-outside.txt`);
  writeFileSync(outsideFile, "fuera\n");
  symlinkSync(outsideFile, join(root, "linked.ts"));
  const outsideDir = join(root, "..", `${root.split("/").pop()}-outside-dir`);
  mkdirSync(outsideDir, { recursive: true });
  writeFileSync(join(outsideDir, "leaked.ts"), "fuga\n");
  symlinkSync(outsideDir, join(root, "linked-dir"));
  return root;
}

const EXPECTED_REAL_FILES = [
  "README.md",
  "docs/guide.md",
  "src/api/handler.ts",
  "src/api/util.ts",
  "src/lib/index.ts",
];

function seedConfig(projectPath: string, scope: unknown): SecurityAuditOrchestratorConfig {
  return {
    runId: "scope-test-run",
    projectPath,
    profile: "quick",
    intent: "full_audit",
    scope,
    budget: { maxInvocations: 10, maxConcurrency: 1, maxDurationMs: 60_000 },
    sourceRef: "abc123",
    sourceDirty: false,
    roster: [],
    priorRuns: [],
  };
}

/** Valida el ledger con el validador OFICIAL de la skill (sin reimplementar). */
function validateLedger(units: readonly SecurityAuditLedgerUnit[]): SecurityAuditUpstreamResult {
  const runDir = mkdtempSync(join(tmpdir(), "factory-scope-rundir-"));
  const file = join(runDir, "coverage-ledger.json");
  const sorted = [...units].sort((a, b) =>
    a.coverage_id < b.coverage_id ? -1 : a.coverage_id > b.coverage_id ? 1 : 0,
  );
  writeFileSync(file, JSON.stringify(sorted));
  try {
    return validateCoverageLedgerFile(file, runDir);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
}

function assertLedgerPasses(units: readonly SecurityAuditLedgerUnit[]): void {
  const result = validateLedger(units);
  assert.equal(
    result.status,
    "PASS",
    `el validador oficial debe dar PASS: ${result.stderr || result.stdout}`,
  );
}

function assertScopeError(error: unknown, code: string): SecurityAuditScopeError {
  assert.ok(error instanceof SecurityAuditScopeError, `se esperaba SecurityAuditScopeError: ${String(error)}`);
  assert.equal(error.code, code);
  return error;
}

test("project scope enumerates only real regular files, deterministically", async () => {
  const root = makeProjectFixture();
  const resolved = await resolveSecurityAuditScopeFiles(root, { kind: "project", scopePaths: [], domains: [] });
  assert.equal(resolved.root, root);
  assert.deepEqual(resolved.files, EXPECTED_REAL_FILES, "solo ficheros regulares reales, en orden binario");
  assert.deepEqual(resolved.scopeFiles, EXPECTED_REAL_FILES, "project autoriza todo el target real");

  const config = seedConfig(root, { kind: "project", scopePaths: [], domains: [] });
  const units = seedSecurityAuditLedger(config, { kind: "project", scopePaths: [], domains: [] }, [], resolved);
  assert.equal(units.length, 1);
  assert.equal(units[0]?.surface, "project/scope-test-run");
  assert.deepEqual(units[0]?.starting_paths, EXPECTED_REAL_FILES, "la semilla usa ficheros reales, nunca vacíos");
  assertLedgerPasses(units);
});

test("domain scope enumerates the real target and keeps official validator PASS", async () => {
  const root = makeProjectFixture();
  const scope = { kind: "domain", scopePaths: [], domains: ["WEB-PROTOCOL-AND-AUTH"] } as const;
  const resolved = await resolveSecurityAuditScopeFiles(root, scope);
  assert.deepEqual(resolved.files, EXPECTED_REAL_FILES);

  const units = seedSecurityAuditLedger(seedConfig(root, scope), scope, [], resolved);
  assert.equal(units.length, 1);
  assert.equal(units[0]?.surface, "WEB-PROTOCOL-AND-AUTH.md");
  assert.deepEqual(units[0]?.starting_paths, EXPECTED_REAL_FILES, "domain usa el target real, sin listas vacías");
  assertLedgerPasses(units);
});

test("directory scope accepts a single file or walks a real directory", async () => {
  const root = makeProjectFixture();
  const scope = { kind: "directory", scopePaths: ["src/api", "README.md"], domains: [] } as const;
  const resolved = await resolveSecurityAuditScopeFiles(root, scope);
  assert.deepEqual(resolved.scopeFiles, [
    "README.md",
    "src/api/handler.ts",
    "src/api/util.ts",
  ]);

  const units = seedSecurityAuditLedger(seedConfig(root, scope), scope, [], resolved);
  assert.equal(units.length, 2);
  const bySurface = new Map(units.map((unit) => [unit.surface, unit]));
  assert.deepEqual(bySurface.get("src/api")?.starting_paths, [
    "src/api/handler.ts",
    "src/api/util.ts",
  ]);
  assert.deepEqual(bySurface.get("README.md")?.starting_paths, ["README.md"]);
  assertLedgerPasses(units);

  // component se comporta igual: recorre el directorio real.
  const componentScope = { kind: "component", scopePaths: ["src"], domains: [] } as const;
  const componentResolved = await resolveSecurityAuditScopeFiles(root, componentScope);
  assert.deepEqual(componentResolved.scopeFiles, [
    "src/api/handler.ts",
    "src/api/util.ts",
    "src/lib/index.ts",
  ]);
  assert.deepEqual(
    startingPathsForScopePath(componentResolved, "src/lib"),
    ["src/lib/index.ts"],
  );
  assertLedgerPasses(seedSecurityAuditLedger(seedConfig(root, componentScope), componentScope, [], componentResolved));
});

test("git-diff uses only the scope paths that are real files", async () => {
  const root = makeProjectFixture();
  const scope = {
    kind: "git-diff",
    scopePaths: ["src/api/handler.ts", "ficticio/inexistente.ts"],
    domains: [],
    baseRef: "base",
    headRef: "head",
  } as const;
  const resolved = await resolveSecurityAuditScopeFiles(root, scope);
  assert.deepEqual(resolved.scopeFiles, ["src/api/handler.ts"]);

  const units = seedSecurityAuditLedger(seedConfig(root, scope), scope, [], resolved);
  assert.equal(units.length, 1);
  assert.deepEqual(units[0]?.starting_paths, ["src/api/handler.ts"]);
  assertLedgerPasses(units);
});

test("an empty eligible file set is rejected explicitly, without truncation", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-scope-empty-"));
  fixtures.push(root);
  // Solo contenido excluido: ningún fichero real elegible.
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(root, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
  writeFileSync(join(root, ".env"), "SECRET=1\n");
  writeFileSync(join(root, "api.key"), "key\n");

  await assert.rejects(
    () => resolveSecurityAuditScopeFiles(root, { kind: "project", scopePaths: [], domains: [] }),
    (error: unknown) => {
      const scopeError = assertScopeError(error, "scope_without_files");
      assert.match(scopeError.message, /no tiene ficheros reales elegibles/);
      return true;
    },
  );
});

test("traversal, absolute, missing, sensitive and symlink scope paths are rejected", async () => {
  const root = makeProjectFixture();
  const base = { kind: "directory", scopePaths: [], domains: [] } as const;

  const cases: Array<[readonly string[], string, RegExp]> = [
    [["../fuera"], "scope_path_traversal", /traversal/],
    [["src/api/../../etc"], "scope_path_traversal", /traversal/],
    [["/etc/passwd"], "scope_path_absolute", /relativo al target/],
    [["ficticio/inexistente.ts"], "scope_path_missing", /inexistente/],
    [[".env"], "scope_path_sensitive", /sensible/],
    [["src/api/handler.ts\\..\\etc"], "scope_path_invalid", /POSIX/],
  ];
  for (const [paths, code, pattern] of cases) {
    await assert.rejects(
      () => resolveSecurityAuditScopeFiles(root, { ...base, scopePaths: [...paths] }),
      (error: unknown) => {
        const scopeError = assertScopeError(error, code);
        assert.match(scopeError.message, pattern);
        return true;
      },
    );
  }

  // Un componente symlink (fichero o directorio) se rechaza y nunca se sigue.
  await assert.rejects(
    () => resolveSecurityAuditScopeFiles(root, { ...base, scopePaths: ["linked.ts"] }),
    (error: unknown) => assertScopeError(error, "scope_path_symlink") !== undefined,
  );
  await assert.rejects(
    () => resolveSecurityAuditScopeFiles(root, { ...base, scopePaths: ["linked-dir/leaked.ts"] }),
    (error: unknown) => assertScopeError(error, "scope_path_symlink") !== undefined,
  );

  // La enumeración del target tampoco sigue symlinks ni incluye su contenido.
  const resolved = await resolveSecurityAuditScopeFiles(root, { kind: "project", scopePaths: [], domains: [] });
  assert.ok(!resolved.files.some((file) => file.includes("linked")), "los symlinks no se enumeran");
  assert.ok(!resolved.files.some((file) => file.startsWith("linked-dir/")), "el dir enlazado no se recorre");
  assert.ok(!resolved.files.includes(".git/HEAD"), ".git queda excluido");
  assert.ok(!resolved.files.includes("node_modules/pkg/index.js"), "node_modules queda excluido");
  assert.ok(!resolved.files.includes(".env"), "los secretos quedan excluidos");
});

test("a directory scope path that yields no eligible real files is rejected", async () => {
  const root = makeProjectFixture();
  // Directorio real pero sin ficheros elegibles (y no sensible).
  const scope = { kind: "directory", scopePaths: ["vacio"], domains: [] } as const;
  await assert.rejects(
    () => resolveSecurityAuditScopeFiles(root, scope),
    (error: unknown) => {
      const scopeError = assertScopeError(error, "scope_path_without_files");
      assert.match(scopeError.message, /no contiene ficheros reales elegibles/);
      return true;
    },
  );
  // Un scope_path sensible se rechaza como sensible.
  const secrets = { kind: "directory", scopePaths: ["secrets"], domains: [] } as const;
  await assert.rejects(
    () => resolveSecurityAuditScopeFiles(root, secrets),
    (error: unknown) => assertScopeError(error, "scope_path_sensitive") !== undefined,
  );
});

test("prior starting paths are filtered against the authorized real set", async () => {
  const root = makeProjectFixture();
  const scope = { kind: "directory", scopePaths: ["src/api"], domains: [] } as const;
  const resolved = await resolveSecurityAuditScopeFiles(root, scope);

  // Solo sobreviven rutas previas que son ficheros reales autorizados.
  assert.deepEqual(
    priorStartingPathsForSurface(
      ["ficticio/no.ts", "src/api/handler.ts", "src/lib/index.ts"],
      resolved.scopeFiles,
      "src/api",
    ),
    ["src/api/handler.ts"],
  );

  // Sin rutas reales previas: fallback determinista bajo la superficie.
  assert.deepEqual(
    priorStartingPathsForSurface(["ficticio/no.ts"], resolved.scopeFiles, "src/api"),
    ["src/api/handler.ts", "src/api/util.ts"],
  );

  // Superficie sin ficheros propios (documento de dominio): conjunto completo.
  assert.deepEqual(
    priorStartingPathsForSurface(["ficticio/no.ts"], resolved.scopeFiles, "WEB-PROTOCOL-AND-AUTH.md"),
    resolved.scopeFiles,
  );

  // Y a través de la semilla con un prior run ficticio: nada inventado.
  const prior = {
    runId: "prior-scope",
    target: root,
    sourceRef: "abc123",
    ledger: [{
      coverage_id: "prior-fake",
      canonical_refs: { surface: "src/api", boundary: "b", subsystem: "s", attack_class: "a" },
      status: "covered",
      starting_paths: ["ficticio/inexistente.ts"],
      result_fingerprints: [],
    }],
    findings: [],
  };
  const units = seedSecurityAuditLedger(seedConfig(root, scope), scope, [prior], resolved);
  const carried = units.find((unit) => unit.coverage_id === "prior-fake");
  assert.ok(carried);
  assert.ok(
    carried.starting_paths.every((path) => resolved.scopeFiles.includes(path)),
    "el prior run ficticio se filtra contra los ficheros reales",
  );
  assert.ok(carried.starting_paths.length > 0, "nunca queda una lista vacía");
});

test("the defensive file limit rejects explicitly instead of truncating", async () => {
  const root = makeProjectFixture();
  // 5 ficheros reales > maxFiles 2: error, sin truncar.
  await assert.rejects(
    () => resolveSecurityAuditScopeFiles(
      root,
      { kind: "project", scopePaths: [], domains: [] },
      { maxFiles: 2 },
    ),
    (error: unknown) => {
      const scopeError = assertScopeError(error, "file_limit");
      assert.match(scopeError.message, /no se trunca la enumeración/);
      return true;
    },
  );
  // El límite también aplica por scope_path de directory.
  await assert.rejects(
    () => resolveSecurityAuditScopeFiles(
      root,
      { kind: "directory", scopePaths: ["src/api"], domains: [] },
      { maxFiles: 1 },
    ),
    (error: unknown) => assertScopeError(error, "file_limit") !== undefined,
  );
  assert.equal(SECURITY_AUDIT_SCOPE_MAX_FILES, 1000);
});

test("the resolver reads files, not names: real content stays inside root", async () => {
  const root = makeProjectFixture();
  const resolved = await resolveSecurityAuditScopeFiles(root, { kind: "project", scopePaths: [], domains: [] });
  // Cada ruta existe realmente dentro del target canónico y es un fichero.
  for (const file of resolved.files) {
    const contents = readFileSync(join(resolved.root, file), "utf8");
    assert.ok(contents.length > 0, `el fichero real ${file} tiene contenido`);
  }
  assert.deepEqual(resolved.files, [...resolved.files].sort(), "orden determinista binario");
});

test("directory scope limit is applied to selected files, not unrelated source files", async () => {
  const root = makeProjectFixture();
  const result = await resolveSecurityAuditScopeFiles(root, { kind: "directory", scopePaths: ["src/api"], domains: [] }, { maxFiles: 2 });
  assert.deepEqual(result.scopeFiles, ["src/api/handler.ts", "src/api/util.ts"]);
});

test("unreadable source directories fail closed rather than silently reducing coverage", async () => {
  if (process.getuid?.() === 0) return;
  const root = makeProjectFixture();
  const dir = join(root, "docs");
  chmodSync(dir, 0o000);
  try {
    await assert.rejects(resolveSecurityAuditScopeFiles(root, { kind: "project", scopePaths: [], domains: [] }), (error) =>
      error instanceof SecurityAuditScopeError && error.code === "walk_unreadable");
  } finally {
    chmodSync(dir, 0o700);
  }
});

test("content snapshot changes even when the file names remain identical", async () => {
  const root = makeProjectFixture();
  const scope = { kind: "project" as const, scopePaths: [], domains: [] };
  const first = await snapshotSecurityAuditScope(await resolveSecurityAuditScopeFiles(root, scope));
  writeFileSync(join(root, "src/api/handler.ts"), "different bytes");
  const second = await snapshotSecurityAuditScope(await resolveSecurityAuditScopeFiles(root, scope));
  assert.notEqual(first.sha256, second.sha256);
  assert.deepEqual(first.files.map((entry) => entry.path), second.files.map((entry) => entry.path));
  assert.ok(!first.files.some((entry) => entry.path === ".env"));
});

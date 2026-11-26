import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { EXECUTION_WAVES } from "./execution-waves.js";
import {
  SecurityAuditStartOptionsError,
  validateSecurityAuditStartOptions,
} from "./security-audit-start.js";

/**
 * Integración mínima con `execution.ts` por REVISIÓN DE CONTRATO: no se
 * invocan motores de pago ni se arranca OpenCode/Claude. Se comprueba que la
 * rama de auditoría existe y enlaza las funciones reales, y que el flujo
 * tradicional sigue usando exactamente las olas oficiales.
 */

const repoRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const executionSource = readFileSync(
  join(repoRoot, "control-center", "src", "api", "execution.ts"),
  "utf8",
);

test("the traditional wave loop is unchanged and only runs without securityAudit", () => {
  // Las olas oficiales siguen intactas (7 olas, mismo orden).
  assert.deepEqual(EXECUTION_WAVES.map((wave) => wave.id), [
    "01 · DESCUBRIMIENTO",
    "02 · RECONSTRUCCIÓN",
    "03 · PROPUESTA",
    "04 · EJECUCIÓN DE PRUEBAS",
    "05 · REVISIÓN CRUZADA",
    "06 · ARBITRAJE FINAL",
  ]);
  assert.equal(EXECUTION_WAVES.length, 6);

  // La rama tradicional permanece detrás de un `else` explícito.
  assert.match(
    executionSource,
    /if \(securityAudit\) \{[\s\S]*?runSecurityAuditOrchestrator\([\s\S]*?\} else \{\s*\n\s*for \(const wave of EXECUTION_WAVES\) \{/,
  );
  // El validador de opciones solo se llama cuando la modalidad está activa.
  assert.match(
    executionSource,
    /const securityAudit = options\.securityAudit\s*\n\s*\? validateSecurityAuditStartOptions\(options\.securityAudit\)\s*\n\s*: null;/,
  );
});

test("the productive adapter creates one execution_agents row and session per instance", () => {
  assert.match(executionSource, /function createSecurityAuditInvoker\(/);
  // Una fila nueva por instancia (los 7 agentes fijos quedan skipped).
  assert.match(executionSource, /appendExecutionAgent\(\{\s*\n\s*id: instanceId,/);
  // Sesión nueva por instancia en OpenCode y controlador nuevo en Claude.
  assert.match(executionSource, /runtime\.sessions\.set\(agent\.id, sessionId\)/);
  assert.match(executionSource, /state\.claudeControllers\.set\(agent\.id, controller\)/);
  // Registro real en security_audit_invocations con los datos del adaptador.
  assert.match(executionSource, /recordSecurityAuditInvocation\(getFactoryDatabase\(\), \{/);
  assert.match(executionSource, /finishSecurityAuditInvocation\(\s*getFactoryDatabase\(\),/);
  // F06: la sesión REAL de la instancia se persiste al cerrar la invocación.
  assert.match(executionSource, /setSecurityAuditInvocationSession\(\s*getFactoryDatabase\(\),/);
  // F06: se registra la intención de plan (y la huella), pero el éxito de la
  // verificación cruzada JAMÁS lo fuerza el invocador productivo.
  assert.match(executionSource, /crossEnginePlanned: request\.crossEnginePlanned/);
  assert.match(executionSource, /fingerprint: request\.fingerprint/);
  assert.equal(executionSource.includes("crossEngineVerified: request.crossEngineVerified"), false,
    "el invocador productivo nunca propaga un éxito cross-engine planificado");
  assert.match(executionSource, /crossEngineVerified: false/);
  // Serialización por motor: no se promete paralelismo que el runtime no da.
  assert.match(executionSource, /queues\[request\.engine\] = current/);
});

test("every audit instance is read-only on both engines, never workspace-write", () => {
  // Instancia productiva: permiso read-only forzado.
  assert.match(
    executionSource,
    /permissionProfile: "read-only",\s*\n\s*permissionMode: "automatic",\s*\n\s*permissionReason: "Modalidad security-audit/,
  );
  // Las 7 filas base de la modalidad también quedan read-only y skipped.
  assert.match(
    executionSource,
    /permissionProfile: "read-only",\s*\n\s*permissionMode: assignment\.permissionMode,\s*\n\s*permissionReason:\s*\n\s*"Modalidad security-audit/,
  );
  assert.match(
    executionSource,
    /"Modalidad security-audit: sin olas tradicionales; las instancias reales se registran por fase/,
  );
  // En esta modalidad no se resuelve ningún perfil de escritura: el bloque de
  // auditoría devuelve antes de llegar a resolveAgentPermissionProfile.
  const auditBranch =
    executionSource.match(
      /assignments\.map\(\(assignment\) => \{\s*\n\s*if \(securityAudit\) \{[\s\S]*?\n      \}/,
    )?.[0] ?? "";
  assert.ok(auditBranch.length > 0, "la rama security-audit existe en el mapeo de agentes");
  assert.match(auditBranch, /permissionProfile: "read-only"/);
  assert.equal(
    auditBranch.includes("resolveAgentPermissionProfile"),
    false,
    "la modalidad security-audit no asigna perfiles de escritura",
  );
});

test("start execution options fail closed before any record is created", () => {
  assert.throws(
    () => validateSecurityAuditStartOptions({ scope: { kind: "project" } }),
    SecurityAuditStartOptionsError,
  );
  assert.throws(
    () => validateSecurityAuditStartOptions({ profile: "standard" }),
    /alcance/,
  );
  assert.throws(
    () => validateSecurityAuditStartOptions({
      profile: "standard",
      scope: { kind: "git-diff", baseRef: "abc", headRef: "abc" },
    }),
    /baseRef/,
  );
  const resolved = validateSecurityAuditStartOptions({
    profile: "deep",
    scope: { kind: "domain", domains: ["WEB-PROTOCOL-AND-AUTH"] },
    resumeRunId: "run-anterior",
  });
  assert.equal(resolved.profile, "deep");
  assert.equal(resolved.resumeRunId, "run-anterior");
  assert.equal(resolved.budget.maxConcurrency, 1, "presupuesto por defecto conservador");
  // F10: la procedencia NO se acepta del cliente; el servidor la resuelve.
  const clientSourceError = (() => {
    try {
      validateSecurityAuditStartOptions({
        profile: "deep",
        scope: { kind: "project" },
        sourceRef: "abc123",
      });
      return null;
    } catch (error) {
      return error as SecurityAuditStartOptionsError;
    }
  })();
  assert.ok(clientSourceError, "sourceRef del cliente se rechaza");
  assert.equal(clientSourceError?.code, "client_source_not_authoritative");
  assert.throws(
    () => validateSecurityAuditStartOptions({
      profile: "deep",
      scope: { kind: "project" },
      sourceDirty: true,
    }),
    /client_source_not_authoritative/,
  );
});

test("M1: el runtime conserva la config canónica, el entrypoint absoluto y el fail-closed", () => {
  // Guard secundario de cableado: la evidencia PRINCIPAL son los tests A/B/C
  // de arranque real del MCP en scripts/factory-filesystem.test.mjs.
  assert.match(executionSource, /let configPath = join\(factoryRoot, "opencode\.json"\)/);
  assert.match(executionSource, /sourceOnlyOpenCodeConfig\(JSON\.parse\(await readFile\(configPath, "utf8"\)\), projectPath\)/);
  assert.match(executionSource, /OPENCODE_CONFIG: configPath/);
  assert.match(executionSource, /OPENCODE_CONFIG_DIR: join\(privateConfigDir \?\? factoryRoot, "\.opencode"\)/);
  assert.match(executionSource, /cwd: privateConfigDir \?\? factoryRoot/);
  assert.match(
    executionSource,
    /FACTORY_FILESYSTEM_MCP_ENTRYPOINT: join\(factoryRoot, "\.opencode", "mcp", "factory-filesystem\.mjs"\)/,
  );
  assert.match(executionSource, /location: \{ directory: runtime\.sessionRoot \?\? projectPath \}/);
  // El fail-closed del MCP sigue presente.
  assert.match(executionSource, /waitForFactoryFilesystemMcp/);
});

test("M3: remediation travels through StartExecutionOptions and the snapshot", () => {
  assert.match(executionSource, /securityRemediation\?: SecurityAuditRemediationLink/);
  assert.match(
    executionSource,
    /planTask\([\s\S]{0,220}securityRemediation: Boolean\(options\.securityRemediation\)/,
  );
  assert.match(executionSource, /securityRemediation: options\.securityRemediation/);
  assert.match(
    executionSource,
    /auditRunId: options\.securityRemediation\.auditRunId,\s*\n\s*fingerprints: \[\.\.\.options\.securityRemediation\.fingerprints\]/,
  );
});

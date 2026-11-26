import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const isolated = mkdtempSync(join(tmpdir(), "factory-security-audit-links-"));
const previousStateDir = process.env.FACTORY_STATE_DIR;
process.env.FACTORY_STATE_DIR = isolated;

// Importar después de fijar el estado aislado: nunca tocar la base real.
const database = await import("./database.js");
const persistence = await import("./security-audit-persistence.js");

persistence.initializeSecurityAuditSchema(database.getFactoryDatabase());

after(() => {
  if (previousStateDir === undefined) delete process.env.FACTORY_STATE_DIR;
  else process.env.FACTORY_STATE_DIR = previousStateDir;
  rmSync(isolated, { recursive: true, force: true });
});

function insertRun(id: string, snapshot: Record<string, unknown>, startedAt = "2026-01-01T00:00:00.000Z"): void {
  database.createExecutionRecords({
    id,
    projectPath: "/srv/example",
    instructions: "Instrucción de prueba",
    status: "queued",
    startedAt,
    threadId: null,
    roundNumber: 1,
    configurationSnapshot: snapshot as never,
    continuityContext: "",
  }, []);
}

test("M8: the audit run resolves its original execution by id", () => {
  insertRun("audit-1-exec", { securityAudit: undefined });
  assert.deepEqual(database.listSecurityAuditExecutionRunIds("audit-1-exec"), ["audit-1-exec"]);
});

test("M8/N2: resume links resolve with json_extract and remediation executions stay out", () => {
  insertRun("exec-resume", { securityAudit: { resumeRunId: "audit-2" } }, "2026-01-01T01:00:00.000Z");
  insertRun(
    "exec-remedio",
    { securityRemediation: { auditRunId: "audit-2", fingerprints: ["fp-1"] } },
    "2026-01-01T02:00:00.000Z",
  );
  // Una nota que CONTIENE el id como texto libre no debe contar como vínculo
  // (el LIKE antiguo sí habría coincidido).
  insertRun("exec-nota", { note: "audit-2" }, "2026-01-01T03:00:00.000Z");

  const links = database.listSecurityAuditExecutionRunIds("audit-2");
  assert.deepEqual(links, ["exec-resume"], "solo ejecuciones securityAudit propias (original o resume)");
  assert.equal(links.includes("exec-nota"), false, "sin coincidencias por LIKE en texto libre");
  assert.equal(links.includes("exec-remedio"), false, "las remediaciones no entran en este vínculo");

  // El vínculo de remediación se consulta aparte, en su propia tabla.
  persistence.createSecurityAuditRun(database.getFactoryDatabase(), {
    runId: "audit-2",
    projectPath: "/srv/example",
    profile: "standard",
    intent: "full_audit",
    scope: { kind: "project" },
    outputDir: join(isolated, "output", "audit-2"),
  });
  persistence.createSecurityAuditRemediation(database.getFactoryDatabase(), {
    runId: "audit-2",
    fingerprint: "fp-1",
    executionRunId: "exec-remedio",
  });
  const remediations = persistence.listSecurityAuditRemediations(database.getFactoryDatabase(), "audit-2");
  assert.equal(remediations.length, 1);
  assert.equal(remediations[0]?.executionRunId, "exec-remedio");
});

test("M8: non-canonical ids are rejected before querying", () => {
  assert.deepEqual(database.listSecurityAuditExecutionRunIds("AUDIT-UPPER"), []);
  assert.deepEqual(database.listSecurityAuditExecutionRunIds(""), []);
  assert.deepEqual(database.listSecurityAuditExecutionRunIds("../../etc"), []);
});

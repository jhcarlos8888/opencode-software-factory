import assert from "node:assert/strict";
import test from "node:test";
import { inspectAuditorShellReceipts, appendAuditorOperationalFindings } from "./auditor-operations.js";

function receipt(id: number, command: string) {
  return { id, area: "TESTER", message: "TOOL shell · completed · " + JSON.stringify({ command }) +
    " · resultado-shell=" + JSON.stringify({ exitCode: 0, output: "" }) };
}
test("Auditor detects real service-killing commands from native receipts", () => {
  const findings = inspectAuditorShellReceipts([
    receipt(14818, "pkill -f 'node server.js' ; sleep 1"),
    receipt(15094, "kill 301397"),
    receipt(14886, "npm run smoke"),
    { id: 15088, area: "TESTER", message: "TOOL shell · running · " + JSON.stringify({ command: "kill 301397" }) }
  ]);
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0]?.evidence, [14818, 15094]);
  assert.match(findings[0]?.description ?? "", /sin prueba de propiedad/i);
});
test("Auditor fixes falsely clean executive summaries", () => {
  const summary = { verdict: "completed" as const, headline: "Todo excelente", overview: "100% perfecto",
    findings: ["Todo bien"], nextSteps: ["Hacer push"] };
  const result = appendAuditorOperationalFindings(summary, inspectAuditorShellReceipts([receipt(2, "kill 301397")]));
  assert.equal(result.verdict, "observations");
  assert.match(result.headline, /incidentes/);
  assert.match(result.findings[0] ?? "", /AUDITOR/);
  assert.equal(result.findings[1], "Todo bien");
  assert.equal(summary.verdict, "completed");
});
test("Ordinary test commands do not trigger false incidents", () => {
  assert.deepEqual(inspectAuditorShellReceipts([receipt(1, "npm run smoke"),receipt(2,"git status --porcelain")]),[]);
});

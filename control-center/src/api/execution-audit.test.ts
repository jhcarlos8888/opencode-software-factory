import assert from "node:assert/strict";
import test from "node:test";
import { formatShellExecutionAuditContext } from "./execution-audit.js";

test("passes the completed shell receipt and exit code to reviewers", () => {
  const context = formatShellExecutionAuditContext([
    {
      id: 1, area: "TESTER", kind: "info", createdAt: "2026-11-18T10:00:00.000Z",
      agentRunId: "tester-run",
      message: "TOOL shell · completed · {\"command\":\"./run-tests.sh\",\"workdir\":\"/sandbox\"} · resultado-shell={\"exitCode\":1,\"output\":\"CONTRACT FAILURES: 3\"}"
    }
  ]);
  assert.match(context, /TOOL shell/);
  assert.match(context, /exitCode/);
  assert.match(context, /CONTRACT FAILURES: 3/);
  assert.match(context, /execution_events SQLite/);
});

test("explicitly states when no native shell receipt exists", () => {
  const context = formatShellExecutionAuditContext([]);
  assert.match(context, /No se encontró ningún evento TOOL shell/);
  assert.match(context, /No infieras ejecución/);
});

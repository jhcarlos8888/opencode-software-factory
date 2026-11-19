import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyOpenCodeServerLog } from "./opencode-log-classifier.js";

test("stderr INFO messages remain informational", () => {
  assert.deepEqual(classifyOpenCodeServerLog("timestamp=2026-11-19 level=INFO GET /api/session status=200", true), {
    kind: "info", failure: false
  });
});

test("explicit WARN and ERROR levels preserve their real severity", () => {
  assert.deepEqual(classifyOpenCodeServerLog("level=WARN retrying request", false), {
    kind: "warning", failure: false
  });
  assert.deepEqual(classifyOpenCodeServerLog("level=ERROR AI.Error.Provider failed", true), {
    kind: "warning", failure: true
  });
});

test("unlabelled stderr output is not automatically marked as a warning", () => {
  assert.deepEqual(classifyOpenCodeServerLog("connection accepted", true), {
    kind: "info", failure: false
  });
  assert.deepEqual(classifyOpenCodeServerLog("request failed unexpectedly", true), {
    kind: "warning", failure: false
  });
});

test("catalog timeout remains a visible server diagnostic, not proof of a failed agent", () => {
  const log = 'timestamp=2026-11-19T15:13:22Z level=ERROR message="Failed to fetch models.dev" cause="TimeoutError: Operation timed out after 10s"';
  assert.deepEqual(classifyOpenCodeServerLog(log, false), {
    kind: "warning", failure: false
  });
  // The session coordinator no longer reads server-wide logs as agent outcomes.
  // A successful session wait plus a canonical final answer stays successful.
});

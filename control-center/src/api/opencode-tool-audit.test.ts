import assert from "node:assert/strict";
import test from "node:test";
import { summarizeOpenCodeToolResult } from "./opencode-tool-audit.js";

test("records shell exit code, bounded output, and duration", () => {
  const summary = summarizeOpenCodeToolResult("shell", {
    status: "completed",
    title: "./run-tests.sh",
    input: { command: "./run-tests.sh", workdir: "/tmp/project" },
    output: "Smoke PASS\nCONTRACT FAILURES: 3\nExit code: 1",
    metadata: { exit: 1 },
    time: { start: 100, end: 135 }
  });
  const audit = JSON.parse(summary.replace(/^ · resultado-shell=/, ""));
  assert.equal(audit.exitCode, 1);
  assert.equal(audit.durationMs, 35);
  assert.match(audit.output, /CONTRACT FAILURES: 3/);
});

test("extracts an explicit exit code from tool output when metadata omits it", () => {
  const summary = summarizeOpenCodeToolResult("shell", {
    status: "completed",
    output: "runner finished\nProcess exited with code 7"
  });
  const audit = JSON.parse(summary.replace(/^ · resultado-shell=/, ""));
  assert.equal(audit.exitCode, 7);
});

test("redacts secrets and limits captured shell output", () => {
  const summary = summarizeOpenCodeToolResult("shell", {
    status: "completed",
    output: "api_key=secret-value\n" + "x".repeat(9000)
  });
  const audit = JSON.parse(summary.replace(/^ · resultado-shell=/, ""));
  assert.ok(audit.output.length <= 5000);
  assert.doesNotMatch(audit.output, /secret-value/);
});

test("does not duplicate raw output from non-shell tools", () => {
  assert.equal(summarizeOpenCodeToolResult("factory_filesystem_read_file", {
    status: "completed",
    output: "private project file"
  }), "");
});

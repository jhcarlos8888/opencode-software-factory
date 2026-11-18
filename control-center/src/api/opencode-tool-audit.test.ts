import assert from "node:assert/strict";
import test from "node:test";
import { summarizeOpenCodeToolResult } from "./opencode-tool-audit.js";

test("records shell exit code, bounded output, and duration in the legacy shape", () => {
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

test("captures OpenCode V2 content and structured exit status", () => {
  const summary = summarizeOpenCodeToolResult("shell", {
    status: "completed",
    input: { command: "./run-tests.sh", workdir: "/sandbox" },
    content: [{ type: "text", text: "Smoke PASS\nCONTRACT FAILURES: 3" }],
    structured: { exit: 1, truncated: false }
  }, { created: 0, ran: 1000, completed: 1042 });
  const audit = JSON.parse(summary.replace(/^ · resultado-shell=/, ""));
  assert.equal(audit.exitCode, 1);
  assert.equal(audit.durationMs, 42);
  assert.match(audit.output, /Smoke PASS/);
  assert.equal(audit.outputTruncated, false);
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
  assert.equal(audit.outputTruncated, true);
});

test("does not duplicate raw output from non-shell tools", () => {
  assert.equal(summarizeOpenCodeToolResult("factory_filesystem_read_file", {
    status: "completed",
    output: "private project file"
  }), "");
});

import test from "node:test";
import assert from "node:assert/strict";
import { classifyClaudeSdkLog } from "./claude-log-classifier.js";

test("Only cosmetic title generation diagnostic is informational and remains visible", () => {
  const message = '[claude-code:unrecognized_model] {"model":"deepseek-v4.1-flash","query_source":"generate_session_title"}';
  const result = classifyClaudeSdkLog(message);
  assert.equal(result.kind, "info");
  assert.ok(result.message.includes(message));
  for (const other of [
    message.replace("generate_session_title", "inference"),
    message + "\nHTTP 429", "HTTP 429", "HTTP 401", "Claude Code crashed",
    '[claude-code:unrecognized_model] {bad json}',
    '[claude-code:unrecognized_model] {"query_source":"generate_session_title"}'
  ]) assert.equal(classifyClaudeSdkLog(other).kind, "warning");
});

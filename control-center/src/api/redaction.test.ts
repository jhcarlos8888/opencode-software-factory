import { prepareHandoffOutput } from "./orchestration.js";
import { redactSecrets } from "./redaction.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { safeJson, sanitizeText } from "./redaction.js";

test("text sanitization redacts bearer, basic, key-value and provider token formats", () => {
  const source = [
    "Authorization: Bearer abc.DEF-123",
    "Authorization=Basic dXNlcjpwYXNzd29yZA==",
    "api_key=sk_live_secret_value",
    "client_secret=\"quoted secret\"",
    "password: super-secret",
    "sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
    "sk-abcdefghijklmnopqrstuvwxyz0123456789"
  ].join(" | ");
  const sanitized = sanitizeText(source);
  assert.doesNotMatch(sanitized, /abc\.DEF-123|dXNlcjpwYXNzd29yZA==|sk_live_secret_value|quoted secret|super-secret|sk-ant-api03|sk-abcdefghijklmnopqrstuvwxyz/);
  assert.equal((sanitized.match(/\[REDACTED\]/g) ?? []).length, 7);
});

test("nested provider payloads redact secret field names and embedded secret values", () => {
  const input = {
    authorization: "Bearer should-not-survive",
    nested: {
      apiKey: "should-not-survive-either",
      prompt: "Use client_secret=hidden-value and then continue",
      messages: [{ role: "assistant", content: "token=another-hidden-value" }]
    },
    plain: "ordinary audit detail"
  };
  const safe = safeJson(input) as any;
  assert.equal(safe.authorization, "[REDACTED]");
  assert.equal(safe.nested.apiKey, "[REDACTED]");
  assert.doesNotMatch(safe.nested.prompt, /hidden-value/);
  assert.doesNotMatch(safe.nested.messages[0].content, /another-hidden-value/);
  assert.equal(safe.plain, "ordinary audit detail");
});

test("handoff redaction hides secrets without truncating long reports", () => {
  const source = "HANDOFF-TESTER-12345678\n" + "detalle técnico. ".repeat(1400) +
    "\nAuthorization: Bearer handoff-secret-token-98765";
  const redacted = redactSecrets(source);
  const handoff = prepareHandoffOutput(redacted, "HANDOFF-TESTER-12345678");
  assert.equal(handoff.truncated, false);
  assert.ok(handoff.content.length > 12000);
  assert.doesNotMatch(handoff.content, /handoff-secret-token-98765/);
  assert.match(handoff.content, /Authorization: Bearer \[REDACTED\]/);
});

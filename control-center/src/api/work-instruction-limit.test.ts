import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_WORK_INSTRUCTION_CHARS, workInstructionLimitError } from "./work-instruction-limit.js";

test("initial and follow-up instructions support twice the former 12k limit", () => {
  assert.equal(MAX_WORK_INSTRUCTION_CHARS, 24_000);
  for (const size of [1, 12_000, 12_001, 23_999, 24_000]) {
    assert.equal(workInstructionLimitError("x".repeat(size)), null, `unexpected rejection at ${size}`);
  }
});

test("oversize instructions are rejected with an explicit message instead of silently truncated", () => {
  const message = workInstructionLimitError("x".repeat(24_001));
  assert.match(message ?? "", /24\.000 caracteres/);
  assert.match(message ?? "", /Reduce el texto/);
});

test("length validation uses the same JavaScript character semantics as textarea maxLength", () => {
  assert.equal(workInstructionLimitError("🙂".repeat(12_000)), null);
  assert.notEqual(workInstructionLimitError("🙂".repeat(12_001)), null);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { retryOpenCodeRead } from "./opencode-request-retry.js";

const immediate = async (_ms: number) => {};

test("GET retries a transient OpenCode API timeout without replaying writes", async () => {
  let attempts = 0;
  const value = await retryOpenCodeRead("GET", async () => {
    if (++attempts < 3) throw new Error("TimeoutError");
    return { ok: true };
  }, immediate);
  assert.deepEqual(value, { ok: true });
  assert.equal(attempts, 3);
});

test("POST is never retried even on transient errors", async () => {
  let attempts = 0;
  await assert.rejects(retryOpenCodeRead("POST", async () => {
    attempts++;
    throw new Error("fetch failed");
  }, immediate), /fetch failed/);
  assert.equal(attempts, 1);
});

test("GET does not retry authorization failures or malformed requests", async () => {
  let attempts = 0;
  await assert.rejects(retryOpenCodeRead("GET", async () => {
    attempts++;
    throw new Error("OpenCode API HTTP 403: forbidden");
  }, immediate), /403/);
  assert.equal(attempts, 1);
});

test("GET stops after bounded transient retries", async () => {
  let attempts = 0;
  await assert.rejects(retryOpenCodeRead("GET", async () => {
    attempts++;
    throw new Error("OpenCode API HTTP 503");
  }, immediate), /503/);
  assert.equal(attempts, 3);
});

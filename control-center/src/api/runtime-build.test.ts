import assert from "node:assert/strict";
import { test } from "node:test";
import { compareRuntimeBuilds, parseRuntimeBuildInfo } from "./runtime-build.js";

const buildA = parseRuntimeBuildInfo(JSON.stringify({
  schemaVersion: 1,
  buildId: "sha256:" + "a".repeat(64),
  generatedAt: "2026-11-17T16:00:00.000Z",
  sourceFileCount: 42
}))!;

const buildB = parseRuntimeBuildInfo(JSON.stringify({
  schemaVersion: 1,
  buildId: "sha256:" + "b".repeat(64),
  generatedAt: "2026-11-17T16:01:00.000Z",
  sourceFileCount: 43
}))!;

test("runtime health is green only when production memory matches the on-disk artifact", () => {
  const status = compareRuntimeBuilds(buildA, buildA, "production");
  assert.equal(status.status, "ok");
  assert.equal(status.runtimeMatchesDisk, true);
  assert.equal(status.verification, "matched");
});

test("runtime health degrades when a newer build artifact is on disk but the daemon is stale", () => {
  const status = compareRuntimeBuilds(buildA, buildB, "production");
  assert.equal(status.status, "degraded");
  assert.equal(status.runtimeMatchesDisk, false);
  assert.equal(status.verification, "mismatch");
  assert.equal(status.runtimeBuildId, buildA.buildId);
  assert.equal(status.artifactBuildId, buildB.buildId);
});

test("production health degrades if the build fingerprint is absent or malformed", () => {
  assert.equal(compareRuntimeBuilds(null, buildA, "production").verification, "missing");
  assert.equal(compareRuntimeBuilds(buildA, null, "production").runtimeMatchesDisk, false);
  assert.equal(parseRuntimeBuildInfo("{not-json"), null);
  assert.equal(parseRuntimeBuildInfo(JSON.stringify({ schemaVersion: 1, buildId: "latest" })), null);
});

test("development mode remains available without a production build fingerprint", () => {
  const status = compareRuntimeBuilds(null, null, "development");
  assert.equal(status.status, "ok");
  assert.equal(status.runtimeMatchesDisk, null);
  assert.equal(status.verification, "development");
});

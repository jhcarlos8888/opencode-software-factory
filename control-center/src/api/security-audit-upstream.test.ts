import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  SECURITY_AUDIT_SKILL_DIR,
  SECURITY_AUDIT_VALIDATORS,
  SecurityAuditUpstreamPathError,
  redactSecurityAuditUpstreamOutput,
  validateCoverageLedgerFile,
  validateFindingsFile,
} from "./security-audit-upstream.js";

const FIXTURE_DIR = fileURLToPath(new URL("./test-fixtures/security-audit/", import.meta.url));
const FINDINGS_VALID = join(FIXTURE_DIR, "findings-valid.json");
const FINDINGS_INVALID = join(FIXTURE_DIR, "findings-invalid.json");
const LEDGER_VALID = join(FIXTURE_DIR, "coverage-ledger-valid.json");
const LEDGER_INVALID = join(FIXTURE_DIR, "coverage-ledger-invalid.json");
const REPO_ROOT = resolve(SECURITY_AUDIT_SKILL_DIR, "..", "..", "..");

function expectPathError(run: () => unknown, code: string): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof SecurityAuditUpstreamPathError, String(error));
    assert.equal(error.code, code);
    return true;
  });
}

test("official findings validator reports PASS and FAIL with redacted output", () => {
  const validatorPath = join(SECURITY_AUDIT_SKILL_DIR, SECURITY_AUDIT_VALIDATORS.findings);
  const before = createHash("sha256").update(readFileSync(validatorPath)).digest("hex");

  const valid = validateFindingsFile(FINDINGS_VALID, FIXTURE_DIR);
  assert.equal(valid.status, "PASS");
  assert.equal(valid.exitCode, 0);
  assert.equal(valid.validator, "findings");
  assert.equal(valid.reason, null);
  assert.match(valid.stdout, /PASS: 3 findings valid/);
  assert.equal(valid.stderr, "");

  const invalid = validateFindingsFile(FINDINGS_INVALID, FIXTURE_DIR);
  assert.equal(invalid.status, "FAIL");
  assert.equal(invalid.exitCode, 1);
  assert.match(invalid.stderr, /FAIL: \d+ validation error\(s\)/);
  assert.equal(invalid.reason, null);

  const after = createHash("sha256").update(readFileSync(validatorPath)).digest("hex");
  assert.equal(after, before, "la capa adaptadora no modifica el validador upstream");
});

test("official coverage ledger validator reports PASS and FAIL", () => {
  const valid = validateCoverageLedgerFile(LEDGER_VALID, FIXTURE_DIR);
  assert.equal(valid.status, "PASS");
  assert.equal(valid.exitCode, 0);
  assert.equal(valid.validator, "coverage-ledger");
  assert.match(valid.stdout, /PASS: 1 coverage units valid/);

  const invalid = validateCoverageLedgerFile(LEDGER_INVALID, FIXTURE_DIR);
  assert.equal(invalid.status, "FAIL");
  assert.equal(invalid.exitCode, 1);
  assert.match(invalid.stderr, /FAIL: \d+ validation error\(s\)/);
});

test("files outside the run directory are rejected without execution", () => {
  const outsideRun = mkdtempSync(join(tmpdir(), "security-audit-outside-run-"));
  try {
    expectPathError(() => validateFindingsFile(FINDINGS_VALID, outsideRun), "input_outside_run");
    expectPathError(
      () => validateFindingsFile(join(outsideRun, "findings.json"), "relative/run"),
      "run_dir_not_absolute",
    );
    expectPathError(
      () => validateFindingsFile(join(outsideRun, "missing.json"), outsideRun),
      "input_missing",
    );
    expectPathError(
      () => validateFindingsFile(FINDINGS_VALID, outsideRun, { skillDir: outsideRun }),
      "skill_dir_outside_factory",
    );
  } finally {
    rmSync(outsideRun, { recursive: true, force: true });
  }
});

test("symlinks inside the run are rejected by the path contract", () => {
  const runDir = mkdtempSync(join(tmpdir(), "security-audit-run-"));
  const outside = mkdtempSync(join(tmpdir(), "security-audit-secret-"));
  try {
    const secret = join(outside, "findings.json");
    writeFileSync(secret, "[]\n");
    symlinkSync(secret, join(runDir, "findings.json"));
    expectPathError(
      () => validateFindingsFile(join(runDir, "findings.json"), runDir),
      "input_symlink",
    );

    const linkedDir = mkdtempSync(join(tmpdir(), "security-audit-run-link-"));
    rmSync(linkedDir, { recursive: true, force: true });
    symlinkSync(outside, linkedDir, "dir");
    try {
      expectPathError(() => validateFindingsFile(secret, linkedDir), "run_dir_symlink");
    } finally {
      unlinkSync(linkedDir);
    }
  } finally {
    rmSync(runDir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a runaway validator is stopped by the timeout", () => {
  const result = validateFindingsFile(FINDINGS_VALID, FIXTURE_DIR, { timeoutMs: 1 });
  assert.equal(result.status, "ERROR");
  assert.equal(result.reason, "timeout");
  assert.doesNotMatch(result.stdout, /PASS:/);
});

test("upstream output is redacted and bounded before leaving the layer", () => {
  const raw = 'stderr: api_key=supersecretvalue123 password: hunter2\n';
  const redacted = redactSecurityAuditUpstreamOutput(raw, 1024);
  assert.equal(redacted.includes("supersecretvalue123"), false);
  assert.equal(redacted.includes("hunter2"), false);
  assert.match(redacted, /\[REDACTED\]/);

  const long = "x".repeat(64);
  const bounded = redactSecurityAuditUpstreamOutput(long, 10);
  assert.equal(Buffer.byteLength(bounded, "utf8"), 10);
});

test("the adapter stays confined to the factory skill directory", () => {
  assert.equal(SECURITY_AUDIT_SKILL_DIR, resolve(REPO_ROOT, ".opencode/skills/security-audit"));
  for (const validator of Object.values(SECURITY_AUDIT_VALIDATORS)) {
    const stats = lstatSync(join(SECURITY_AUDIT_SKILL_DIR, validator));
    assert.equal(stats.isSymbolicLink(), false, validator);
    assert.equal(stats.isFile(), true, validator);
  }
  assert.equal(SECURITY_AUDIT_VALIDATORS.findings, "validate-findings.cjs");
  assert.equal(SECURITY_AUDIT_VALIDATORS["coverage-ledger"], "validate-coverage-ledger.cjs");
});

test("upstream skill files still match the provenance manifest", () => {
  const manifest = readFileSync(join(REPO_ROOT, "docs/security-operations/provenance.sha256"), "utf8");
  const entries = manifest
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const parts = line.split(/\s+/);
      return { hash: parts[0] ?? "", relPath: parts[1] ?? "" };
    });
  assert.ok(entries.length >= 21, "el manifiesto debe cubrir la skill importada");
  for (const { hash, relPath } of entries) {
    const actual = createHash("sha256")
      .update(readFileSync(join(REPO_ROOT, relPath)))
      .digest("hex");
    assert.equal(actual, hash, relPath);
  }
  assert.ok(entries.some((entry) => entry.relPath === ".opencode/skills/security-audit/SKILL.md"));
  assert.ok(
    entries.some((entry) => entry.relPath === ".opencode/skills/security-audit/report-schema.json"),
  );
  assert.ok(entries.some((entry) => entry.relPath === ".opencode/skills/security-audit/LICENSE"));
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifySecurityAudits,
  formatSecurityAuditReport,
  KNOWN_DEV_ADVISORY
} from "./security-audit.mjs";

function advisory(title, url) {
  return { title, url, severity: "high", range: "*" };
}

function knownFullAudit() {
  return {
    metadata: { vulnerabilities: { total: 5, high: 5, critical: 0 } },
    vulnerabilities: {
      picomatch: { severity: "high", via: [advisory("picomatch ReDoS", KNOWN_DEV_ADVISORY)] },
      fdir: { severity: "high", via: ["picomatch"] },
      tinyglobby: { severity: "high", via: ["fdir", "picomatch"] },
      vite: { severity: "high", via: ["picomatch", "tinyglobby"] },
      "@vitejs/plugin-react": { severity: "high", via: ["vite"] }
    }
  };
}

test("known upstream dev-only picomatch advisory is tracked without hiding production risks", () => {
  const result = classifySecurityAudits(
    { metadata: { vulnerabilities: { total: 0, high: 0, critical: 0 } }, vulnerabilities: {} },
    knownFullAudit()
  );
  assert.equal(result.passed, true);
  assert.equal(result.knownDevAdvisory.packages.length, 5);
  assert.equal(result.unknownFindings.length, 0);
  assert.match(formatSecurityAuditReport(result), /sin release npm verificable/i);
});

test("a new unknown high or critical advisory blocks the verification gate", () => {
  const full = knownFullAudit();
  full.metadata.vulnerabilities.total = 6;
  full.metadata.vulnerabilities.high = 6;
  full.vulnerabilities.fastify = {
    severity: "critical",
    via: [advisory("Unknown critical issue", "https://example.invalid/GHSA-unknown")]
  };
  const result = classifySecurityAudits(
    { metadata: { vulnerabilities: { total: 0, high: 0, critical: 0 } }, vulnerabilities: {} },
    full
  );
  assert.equal(result.passed, false);
  assert.equal(result.unknownFindings.length, 1);
  assert.equal(result.unknownFindings[0].name, "fastify");
});

test("a production high or critical vulnerability blocks verification", () => {
  const result = classifySecurityAudits(
    { metadata: { vulnerabilities: { total: 1, high: 1, critical: 0 } }, vulnerabilities: {} },
    knownFullAudit()
  );
  assert.equal(result.passed, false);
  assert.equal(result.production.high, 1);
});

test("even moderate or low production dependency advisories block the gate", () => {
  const result = classifySecurityAudits(
    { metadata: { vulnerabilities: { total: 1, high: 0, critical: 0, moderate: 1 } }, vulnerabilities: {} },
    knownFullAudit()
  );
  assert.equal(result.passed, false);
  assert.equal(result.production.total, 1);
});

test("unresolvable vulnerability chains fail closed", () => {
  const full = {
    metadata: { vulnerabilities: { total: 1, high: 1, critical: 0 } },
    vulnerabilities: {
      vite: { severity: "high", via: ["unindexed-dependency"] }
    }
  };
  const result = classifySecurityAudits(
    { metadata: { vulnerabilities: { total: 0, high: 0, critical: 0 } }, vulnerabilities: {} },
    full
  );
  assert.equal(result.passed, false);
  assert.equal(result.unknownFindings.length, 1);
});

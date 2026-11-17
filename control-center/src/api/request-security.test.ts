import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ALLOWED_BROWSER_ORIGINS,
  CONTROL_CENTER_SECURITY_HEADERS,
  inspectRequestSecurity
} from "./request-security.js";

test("only the local Vite and Control Center origins are trusted", () => {
  for (const origin of ALLOWED_BROWSER_ORIGINS) {
    assert.equal(inspectRequestSecurity({ origin }).allowed, true);
  }
  assert.equal(inspectRequestSecurity({ origin: "https://attacker.example" }).allowed, false);
  assert.equal(inspectRequestSecurity({ origin: "null" }).allowed, false);
});

test("cross-site browser fetches are rejected even without a trusted origin", () => {
  assert.equal(inspectRequestSecurity({ secFetchSite: "cross-site" }).allowed, false);
  assert.equal(inspectRequestSecurity({ origin: "http://127.0.0.1:5173", secFetchSite: "cross-site" }).allowed, false);
  assert.equal(inspectRequestSecurity({ origin: "http://127.0.0.1:5173", secFetchSite: "same-origin" }).allowed, true);
});

test("local CLI requests without browser provenance remain supported", () => {
  assert.deepEqual(inspectRequestSecurity({}), { allowed: true, reason: null });
  assert.deepEqual(inspectRequestSecurity({ secFetchSite: "none" }), { allowed: true, reason: null });
});

test("security headers prevent MIME sniffing, framing and capability access", () => {
  assert.equal(CONTROL_CENTER_SECURITY_HEADERS["X-Content-Type-Options"], "nosniff");
  assert.equal(CONTROL_CENTER_SECURITY_HEADERS["X-Frame-Options"], "DENY");
  assert.match(CONTROL_CENTER_SECURITY_HEADERS["Content-Security-Policy"], /default-src 'self'/);
  assert.match(CONTROL_CENTER_SECURITY_HEADERS["Content-Security-Policy"], /frame-ancestors 'none'/);
  assert.match(CONTROL_CENTER_SECURITY_HEADERS["Permissions-Policy"], /camera=\(\)/);
});

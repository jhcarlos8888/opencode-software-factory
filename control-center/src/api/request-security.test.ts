import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ALLOWED_BROWSER_ORIGINS,
  CONTROL_CENTER_SECURITY_HEADERS,
  allowedBrowserOrigins,
  effectiveApiPort,
  inspectRequestSecurity
} from "./request-security.js";

test("only the local Vite and Control Center origins are trusted", () => {
  for (const origin of ALLOWED_BROWSER_ORIGINS) {
    assert.equal(inspectRequestSecurity({ origin }, {}).allowed, true);
  }
  assert.equal(inspectRequestSecurity({ origin: "https://attacker.example" }, {}).allowed, false);
  assert.equal(inspectRequestSecurity({ origin: "null" }, {}).allowed, false);
});

test("the effective API port is validated and falls back to the default", () => {
  assert.equal(effectiveApiPort({}), 4141);
  assert.equal(effectiveApiPort({ FACTORY_API_PORT: "5175" }), 5175);
  assert.equal(effectiveApiPort({ FACTORY_API_PORT: " 4242 " }), 4242);
  assert.equal(effectiveApiPort({ FACTORY_API_PORT: "0" }), 4141, "fuera de rango");
  assert.equal(effectiveApiPort({ FACTORY_API_PORT: "65536" }), 4141, "fuera de rango");
  assert.equal(effectiveApiPort({ FACTORY_API_PORT: "-1" }), 4141, "negativo");
  assert.equal(effectiveApiPort({ FACTORY_API_PORT: "abc" }), 4141, "no numérico");
  assert.equal(effectiveApiPort({ FACTORY_API_PORT: "8080x" }), 4141, "sufijo");
  assert.equal(effectiveApiPort({ FACTORY_API_PORT: "" }), 4141, "vacío");
});

test("a custom FACTORY_API_PORT allows loopback origins on that port only", () => {
  const env = { FACTORY_API_PORT: "5175" };
  // El puerto efectivo se acepta en ambos hosts de bucle…
  assert.equal(inspectRequestSecurity({ origin: "http://127.0.0.1:5175" }, env).allowed, true);
  assert.equal(inspectRequestSecurity({ origin: "http://localhost:5175" }, env).allowed, true);
  // …y se conservan Vite 5173 y el default 4141.
  assert.equal(inspectRequestSecurity({ origin: "http://127.0.0.1:5173" }, env).allowed, true);
  assert.equal(inspectRequestSecurity({ origin: "http://localhost:4141" }, env).allowed, true);
  // El puerto por defecto sigue aceptándose (compatibilidad).
  assert.equal(inspectRequestSecurity({ origin: "http://127.0.0.1:4141" }, env).allowed, true);
  // El puerto antiguo de la API ya no es el efectivo: sin env, 5175 está vetado.
  assert.equal(inspectRequestSecurity({ origin: "http://127.0.0.1:5175" }, {}).allowed, false);
  // El entorno se lee por llamada: cambiar la variable cambia el resultado.
  assert.equal(
    inspectRequestSecurity({ origin: "http://127.0.0.1:4242" }, { FACTORY_API_PORT: "4242" }).allowed,
    true
  );
});

test("custom ports never widen the allow-list to remote or malicious origins", () => {
  const env = { FACTORY_API_PORT: "5175" };
  assert.equal(inspectRequestSecurity({ origin: "https://attacker.example:5175" }, env).allowed, false);
  assert.equal(inspectRequestSecurity({ origin: "http://evil.example:5175" }, env).allowed, false);
  assert.equal(inspectRequestSecurity({ origin: "http://127.0.0.1:5175.evil.example" }, env).allowed, false);
  assert.equal(inspectRequestSecurity({ origin: "http://192.168.1.10:5175" }, env).allowed, false);
  assert.equal(inspectRequestSecurity({ origin: "http://127.0.0.1:5176" }, env).allowed, false, "otro puerto de bucle");
  assert.equal(inspectRequestSecurity({ origin: "null" }, env).allowed, false);
  assert.equal(inspectRequestSecurity({ origin: "http://127.0.0.1:5175", secFetchSite: "cross-site" }, env).allowed, false);
  // Puerto inválido → no amplía la lista (sigue solo el default).
  const invalid = { FACTORY_API_PORT: "99999" };
  assert.equal(inspectRequestSecurity({ origin: "http://127.0.0.1:99999" }, invalid).allowed, false);
  assert.equal(inspectRequestSecurity({ origin: "http://127.0.0.1:4141" }, invalid).allowed, true);
});

test("allowedBrowserOrigins is rebuilt per call without caching the environment", () => {
  const first = allowedBrowserOrigins({ FACTORY_API_PORT: "5175" });
  const second = allowedBrowserOrigins({});
  assert.equal(first.has("http://127.0.0.1:5175"), true);
  assert.equal(second.has("http://127.0.0.1:5175"), false, "sin cachear la env anterior");
  assert.equal(second.has("http://127.0.0.1:4141"), true);
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

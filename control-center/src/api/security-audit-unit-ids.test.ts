import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  buildSecurityAuditUnitIdIndex,
  resolveSecurityAuditUnitReference,
  shortUnitId,
  type SecurityAuditUnitIdIndex,
} from "./security-audit-unit-ids.js";

/** Short id asignado a un coverage_id según el índice. */
function shortOf(index: SecurityAuditUnitIdIndex, coverageId: string): string | undefined {
  for (const [short, coverage] of index.byShort) {
    if (coverage === coverageId) return short;
  }
  return undefined;
}

test("shortUnitId es determinista y deriva del sha256 del coverage_id", () => {
  const digest = createHash("sha256").update("abc").digest("hex");
  assert.equal(shortUnitId("abc"), `U${digest.slice(0, 8)}`);
  assert.equal(shortUnitId("abc"), shortUnitId("abc"));
  assert.notEqual(shortUnitId("abc"), shortUnitId("abd"));
  // Longitud explícita.
  assert.equal(shortUnitId("abc", 10), `U${digest.slice(0, 10)}`);
  assert.equal(shortUnitId("abc", 10).length, 11);
});

test("el índice es determinista y estable ante cambios de orden", () => {
  const units = [
    { coverage_id: "cov-b", surface: "src/api", result_fingerprints: ["fp-b"] },
    { coverage_id: "cov-a", surface: "src/lib", result_fingerprints: ["fp-a"] },
    { coverage_id: "cov-c", surface: "src/api", result_fingerprints: ["fp-c"] },
  ];
  const index1 = buildSecurityAuditUnitIdIndex(units);
  const index2 = buildSecurityAuditUnitIdIndex([...units].reverse());
  assert.deepEqual([...index1.byShort], [...index2.byShort]);
  assert.deepEqual([...index1.bySurface], [...index2.bySurface]);
  assert.deepEqual([...index1.byFingerprint], [...index2.byFingerprint]);
  // IDs cortos únicos por unidad.
  assert.equal(index1.byShort.size, 3);
  assert.equal(new Set(index1.byShort.keys()).size, 3);
  // bySurface agrupa por canonical_refs.surface ?? surface.
  assert.deepEqual(index1.bySurface.get("src/api"), ["cov-b", "cov-c"]);
  assert.deepEqual(index1.bySurface.get("src/lib"), ["cov-a"]);
});

test("colisión forzada de prefijo: los IDs cortos siguen únicos y ambos se desambiguan", () => {
  // Busca dos cadenas cuyo sha256 comparta los primeros 8 hex (fuerza de
  // cumpleaños sobre prefijos de 32 bits: ~2^16 iteraciones).
  let pair: [string, string] | null = null;
  const seen = new Map<string, string>();
  for (let i = 0; i < 2_000_000 && pair === null; i += 1) {
    const candidate = `colision-paquete-3-${i}`;
    const prefix = createHash("sha256").update(candidate).digest("hex").slice(0, 8);
    const previous = seen.get(prefix);
    if (previous !== undefined) pair = [previous, candidate];
    else seen.set(prefix, candidate);
  }
  assert.ok(pair !== null, "no se encontró colisión de prefijo de 8 hex");
  const [idA, idB] = pair;
  const index = buildSecurityAuditUnitIdIndex([
    { coverage_id: idA, surface: "src/a" },
    { coverage_id: idB, surface: "src/b" },
  ]);
  const shortA = shortOf(index, idA);
  const shortB = shortOf(index, idB);
  assert.ok(shortA && shortB);
  assert.notEqual(shortA, shortB, "los IDs cortos en colisión siguen siendo únicos");
  // Ambos implicados se recalculan a más de 8 hex (desambiguados).
  assert.ok(shortA.length > 9, `${shortA} quedó desambiguado`);
  assert.ok(shortB.length > 9, `${shortB} quedó desambiguado`);
  // Reconstruir el índice da exactamente los mismos IDs.
  const rebuilt = buildSecurityAuditUnitIdIndex([
    { coverage_id: idB, surface: "src/b" },
    { coverage_id: idA, surface: "src/a" },
  ]);
  assert.deepEqual([...rebuilt.byShort], [...index.byShort]);
  // Y cada short id resuelve a SU coverage_id.
  const all = new Set([idA, idB]);
  assert.deepEqual(resolveSecurityAuditUnitReference(shortA, index, all), {
    ok: true,
    coverageId: idA,
    via: "short_id",
  });
  assert.deepEqual(resolveSecurityAuditUnitReference(shortB, index, all), {
    ok: true,
    coverageId: idB,
    via: "short_id",
  });
});

test("resuelve por coverage_id exacto, short id, surface única y fingerprint único", () => {
  const coverageA = "coverage-a::%3Aperfil-encoded-largo";
  const coverageB = "coverage-b::%3Aperfil-encoded-largo";
  const index = buildSecurityAuditUnitIdIndex([
    { coverage_id: coverageA, surface: "src/api", result_fingerprints: ["fp-a"] },
    { coverage_id: coverageB, surface: "src/lib", result_fingerprints: ["fp-b"] },
  ]);
  const all = new Set([coverageA, coverageB]);
  // (1) coverage_id exacto.
  assert.deepEqual(resolveSecurityAuditUnitReference(coverageA, index, all), {
    ok: true,
    coverageId: coverageA,
    via: "coverage_id",
  });
  // (2) short id exacto.
  const shortA = shortOf(index, coverageA);
  assert.ok(shortA);
  assert.deepEqual(resolveSecurityAuditUnitReference(shortA, index, all), {
    ok: true,
    coverageId: coverageA,
    via: "short_id",
  });
  // (3) surface exacta con una única unidad.
  assert.deepEqual(resolveSecurityAuditUnitReference("src/api", index, all), {
    ok: true,
    coverageId: coverageA,
    via: "surface",
  });
  // (4) fingerprint presente en exactamente una unidad.
  assert.deepEqual(resolveSecurityAuditUnitReference("fp-b", index, all), {
    ok: true,
    coverageId: coverageB,
    via: "fingerprint",
  });
});

test("surface o fingerprint compartidos por varias unidades son ambiguos", () => {
  const cov1 = "cov-1::largo";
  const cov2 = "cov-2::largo";
  const index = buildSecurityAuditUnitIdIndex([
    { coverage_id: cov1, surface: "src/api", result_fingerprints: ["fp-compartido"] },
    { coverage_id: cov2, surface: "src/api", result_fingerprints: ["fp-compartido"] },
  ]);
  const all = new Set([cov1, cov2]);
  assert.deepEqual(resolveSecurityAuditUnitReference("src/api", index, all), {
    ok: false,
    reason: "ambiguous",
    matches: [cov1, cov2],
  });
  assert.deepEqual(resolveSecurityAuditUnitReference("fp-compartido", index, all), {
    ok: false,
    reason: "ambiguous",
    matches: [cov1, cov2],
  });
  // Por coverage_id o short id esas mismas unidades siguen resolviendo.
  assert.deepEqual(resolveSecurityAuditUnitReference(cov1, index, all), {
    ok: true,
    coverageId: cov1,
    via: "coverage_id",
  });
  const short1 = shortOf(index, cov1);
  assert.ok(short1);
  assert.deepEqual(resolveSecurityAuditUnitReference(short1, index, all), {
    ok: true,
    coverageId: cov1,
    via: "short_id",
  });
});

test("referencias desconocidas nunca se inventan ni resuelven por similitud", () => {
  const index = buildSecurityAuditUnitIdIndex([
    { coverage_id: "cov-x::largo", surface: "src/api", result_fingerprints: ["fp-x"] },
  ]);
  const all = new Set(["cov-x::largo"]);
  assert.deepEqual(resolveSecurityAuditUnitReference("src#trust-boundary", index, all), {
    ok: false,
    reason: "unknown",
    matches: [],
  });
  // Subcadenas y prefijos NO resuelven.
  assert.deepEqual(resolveSecurityAuditUnitReference("src", index, all), {
    ok: false,
    reason: "unknown",
    matches: [],
  });
  assert.deepEqual(resolveSecurityAuditUnitReference("cov-x", index, all), {
    ok: false,
    reason: "unknown",
    matches: [],
  });
  assert.deepEqual(resolveSecurityAuditUnitReference("fp", index, all), {
    ok: false,
    reason: "unknown",
    matches: [],
  });
  assert.deepEqual(resolveSecurityAuditUnitReference("", index, all), {
    ok: false,
    reason: "unknown",
    matches: [],
  });
});

test("los tres IDs reales del defecto de fase H (run c36e5d74) se resuelven", () => {
  // Escenario del defecto: unidades candidatas cuyo result_fingerprints[0] es
  // el fingerprint legible que el crítico devolvió en reassign_ids.
  const coverageBAC = "coverage::BAC-documents-updateDocument-encoded";
  const coverageBola = "coverage::documents-update-bola-encoded";
  const index = buildSecurityAuditUnitIdIndex([
    {
      coverage_id: coverageBAC,
      surface: "documents/updateDocument",
      result_fingerprints: ["BAC-documents-updateDocument-sin-comprobacion-de-propietario"],
    },
    {
      coverage_id: coverageBola,
      surface: "documents/update",
      result_fingerprints: ["documents-update-missing-owner-check-bola-write"],
    },
  ]);
  const all = new Set([coverageBAC, coverageBola]);
  // 1) fingerprint de la unidad BAC → resuelve por fingerprint.
  assert.deepEqual(
    resolveSecurityAuditUnitReference("BAC-documents-updateDocument-sin-comprobacion-de-propietario", index, all),
    { ok: true, coverageId: coverageBAC, via: "fingerprint" },
  );
  // 2) fingerprint de la unidad bola-write → resuelve por fingerprint.
  assert.deepEqual(
    resolveSecurityAuditUnitReference("documents-update-missing-owner-check-bola-write", index, all),
    { ok: true, coverageId: coverageBola, via: "fingerprint" },
  );
  // 3) referencia que no corresponde a ninguna unidad → desconocida.
  assert.deepEqual(resolveSecurityAuditUnitReference("src#trust-boundary", index, all), {
    ok: false,
    reason: "unknown",
    matches: [],
  });
});

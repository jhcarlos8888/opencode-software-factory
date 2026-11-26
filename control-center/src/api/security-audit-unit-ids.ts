/**
 * Identificadores cortos y resolución de referencias de unidades del ledger de
 * `security-audit` (Paquete 3).
 *
 * Los `coverage_id` oficiales son cadenas canónicas percent-encoded (cientos
 * de caracteres, con segmentos `::`) que un crítico no puede reproducir de
 * forma fiable: en la fase H el crítico devolvía fingerprints legibles y
 * `applyCriticPlan` los rechazaba como IDs desconocidos. Este módulo PURO (sin
 * red, sin base de datos, solo `node:crypto`) proporciona:
 *
 * - `shortUnitId`: derivación determinista de un identificador corto estable
 *   ("U" + prefijo hex del sha256 del `coverage_id`).
 * - `buildSecurityAuditUnitIdIndex`: índice de unidades por short id, surface
 *   y fingerprints, con unicidad determinista de los IDs cortos (ante colisión
 *   de prefijos, los implicados se recalculan a 10, 12… hex hasta
 *   desambiguar, en orden determinista por `coverage_id`).
 * - `resolveSecurityAuditUnitReference`: resolución ESTRICTA de la referencia
 *   de un crítico (coincidencia exacta; nunca similitud, subcadenas ni
 *   unidades inventadas).
 *
 * El ID corto es SOLO para los prompts: el `coverage_id` oficial y el esquema
 * del ledger y los artefactos no cambian.
 */

import { createHash } from "node:crypto";

/** Longitud hex por omisión del identificador corto. */
const DEFAULT_HEX_LENGTH = 8;
/** Longitud hex máxima del digest sha256 (cota del escalado por colisión). */
const MAX_HEX_LENGTH = 64;
/** Paso de escalado de la longitud hex al desambiguar colisiones. */
const HEX_LENGTH_STEP = 2;

/** Comparación binaria lexicográfica (no locale), como el validador oficial. */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** ID corto y estable de una unidad: "U" + prefijo hex de su sha256. */
export function shortUnitId(coverageId: string, hexLength?: number): string {
  const length = hexLength ?? DEFAULT_HEX_LENGTH;
  return `U${createHash("sha256").update(coverageId).digest("hex").slice(0, length)}`;
}

export interface SecurityAuditUnitIdIndex {
  /** ID corto → coverage_id (unicidad garantizada por construcción). */
  byShort: Map<string, string>;
  /** surface (canónica si existe) → coverage_ids que la declaran. */
  bySurface: Map<string, string[]>;
  /** fingerprint presente en `result_fingerprints` → coverage_ids que lo llevan. */
  byFingerprint: Map<string, string[]>;
}

/**
 * Asigna a cada coverage_id un short id ÚNICO y determinista: se calcula a 8
 * hex y, si hay colisión de prefijos, SOLO los implicados se recalculan a 10,
 * 12… hex hasta desambiguar. El orden es determinista por coverage_id.
 */
function assignShortIds(coverageIds: readonly string[]): Map<string, string> {
  const assigned = new Map<string, string>();
  const taken = new Set<string>();
  // Deduplicación + orden determinista (la entrada puede venir en cualquier
  // orden y repetida; el resultado no depende de ello).
  let pending = [...new Set(coverageIds)].sort(compareStrings);
  let hexLength = DEFAULT_HEX_LENGTH;
  while (pending.length > 0) {
    if (hexLength > MAX_HEX_LENGTH) {
      // Inalcanzable con coverage_ids distintos (exigiría colisión completa de
      // sha256); se preserva la unicidad con un sufijo ordinal determinista.
      for (const [index, coverageId] of pending.entries()) {
        const short = `${shortUnitId(coverageId, MAX_HEX_LENGTH)}-${index + 1}`;
        assigned.set(short, coverageId);
        taken.add(short);
      }
      break;
    }
    // Agrupa por prefijo hex de la longitud actual: los solitarios quedan
    // asignados y los grupos en colisión pasan a la longitud siguiente.
    const groups = new Map<string, string[]>();
    for (const coverageId of pending) {
      const prefix = createHash("sha256").update(coverageId).digest("hex").slice(0, hexLength);
      const group = groups.get(prefix);
      if (group) group.push(coverageId);
      else groups.set(prefix, [coverageId]);
    }
    const nextPending: string[] = [];
    for (const [prefix, group] of [...groups].sort((a, b) => compareStrings(a[0], b[0]))) {
      const [only] = group;
      if (group.length === 1 && only !== undefined && !taken.has(`U${prefix}`)) {
        const short = `U${prefix}`;
        assigned.set(short, only);
        taken.add(short);
      } else {
        nextPending.push(...group);
      }
    }
    pending = nextPending;
    hexLength += HEX_LENGTH_STEP;
  }
  return assigned;
}

export function buildSecurityAuditUnitIdIndex(
  units: ReadonlyArray<{
    coverage_id: string;
    surface?: string;
    canonical_refs?: { surface?: string };
    result_fingerprints?: readonly string[];
  }>,
): SecurityAuditUnitIdIndex {
  const byShort = assignShortIds(units.map((unit) => unit.coverage_id));

  const bySurface = new Map<string, string[]>();
  const byFingerprint = new Map<string, string[]>();
  const push = (map: Map<string, string[]>, key: string, coverageId: string): void => {
    const list = map.get(key);
    if (list) {
      if (!list.includes(coverageId)) list.push(coverageId);
    } else {
      map.set(key, [coverageId]);
    }
  };
  for (const unit of units) {
    const coverageId = unit.coverage_id;
    if (typeof coverageId !== "string" || coverageId.length === 0) continue;
    const surface = unit.canonical_refs?.surface ?? unit.surface;
    if (typeof surface === "string" && surface.length > 0) {
      push(bySurface, surface, coverageId);
    }
    for (const fingerprint of unit.result_fingerprints ?? []) {
      if (typeof fingerprint === "string" && fingerprint.length > 0) {
        push(byFingerprint, fingerprint, coverageId);
      }
    }
  }
  // Determinista ante cambios de orden en la entrada: listas por coverage_id
  // y claves insertadas en orden binario.
  for (const list of bySurface.values()) list.sort(compareStrings);
  for (const list of byFingerprint.values()) list.sort(compareStrings);
  const byKeyOrder = (map: Map<string, string[]>): Map<string, string[]> =>
    new Map([...map].sort((a, b) => compareStrings(a[0], b[0])));
  return { byShort, bySurface: byKeyOrder(bySurface), byFingerprint: byKeyOrder(byFingerprint) };
}

export type SecurityAuditUnitReferenceResolution =
  | { ok: true; coverageId: string; via: "coverage_id" | "short_id" | "surface" | "fingerprint" }
  | { ok: false; reason: "unknown" | "ambiguous"; matches: string[] };

/**
 * Resolución ESTRICTA de una referencia de crítico contra el índice del
 * ledger. Reglas, en este orden:
 * 1. `coverage_id` oficial exacto.
 * 2. ID corto exacto.
 * 3. surface EXACTA que pertenezca a exactamente una unidad (si hay varias →
 *    ambigua).
 * 4. fingerprint EXACTO presente en `result_fingerprints` de exactamente una
 *    unidad (si hay varias → ambiguo).
 * 5. En cualquier otro caso, desconocido.
 *
 * Nunca inventa unidades ni resuelve por similitud parcial o subcadenas.
 */
export function resolveSecurityAuditUnitReference(
  raw: string,
  index: SecurityAuditUnitIdIndex,
  allCoverageIds: ReadonlySet<string>,
): SecurityAuditUnitReferenceResolution {
  // (1) coverage_id oficial exacto.
  if (allCoverageIds.has(raw)) {
    return { ok: true, coverageId: raw, via: "coverage_id" };
  }
  // (2) ID corto exacto (solo si apunta a una unidad viva del ledger).
  const byShort = index.byShort.get(raw);
  if (byShort !== undefined && allCoverageIds.has(byShort)) {
    return { ok: true, coverageId: byShort, via: "short_id" };
  }
  // (3) surface exacta: solo si apunta a exactamente una unidad.
  const bySurface = index.bySurface.get(raw);
  if (bySurface !== undefined) {
    const [only] = bySurface;
    if (bySurface.length === 1 && only !== undefined) {
      return { ok: true, coverageId: only, via: "surface" };
    }
    return { ok: false, reason: "ambiguous", matches: [...bySurface] };
  }
  // (4) fingerprint exacto presente en exactamente una unidad.
  const byFingerprint = index.byFingerprint.get(raw);
  if (byFingerprint !== undefined) {
    const [only] = byFingerprint;
    if (byFingerprint.length === 1 && only !== undefined) {
      return { ok: true, coverageId: only, via: "fingerprint" };
    }
    return { ok: false, reason: "ambiguous", matches: [...byFingerprint] };
  }
  // (5) Desconocido: jamás se resuelve por similitud.
  return { ok: false, reason: "unknown", matches: [] };
}

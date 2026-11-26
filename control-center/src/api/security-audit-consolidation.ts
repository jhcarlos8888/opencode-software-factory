/**
 * Paquete 2: consolidación conservadora de candidatos duplicados ANTES de
 * gastar verificaciones de la fase 3.
 *
 * Módulo PURO: sin red, sin base de datos y sin reloj. Todas las funciones son
 * deterministas e independientes del orden de entrada.
 *
 * Regla central: dos candidatos describen el MISMO hallazgo solo cuando
 * comparten EXACTAMENTE la hipótesis original, ubicación concreta, frontera,
 * operación, control ausente, alcance y evidencia. Los slugs solos no bastan. NUNCA
 * se agrupa por similitud textual, subcadenas, distancia de edición ni por
 * compartir solo el archivo o solo la clase de ataque: un vínculo único es
 * insuficiente y una fusión errónea destruiría evidencia real.
 */

import { createHash } from "node:crypto";

/** Identidad de un candidato, derivada de sus referencias canónicas. */
export interface CandidateIdentityInput {
  fingerprint: string;
  unitId: string;
  /** canonical_refs.surface */
  surface: string;
  /** canonical_refs.boundary */
  boundary: string;
  subsystem: string;
  /** canonical_refs.attack_class */
  attackClass: string;
  startingPaths: readonly string[];
  /** Registro estructurado del hunter si existe (null si no se conocía). */
  candidate: Record<string, unknown> | null;
}

export interface CandidateIdentity {
  file: string | null;
  operation: "read" | "write" | "update" | "delete" | null;
  missingControl: string | null;
  attackClass: string;
  /** Evidencias internas contradictorias (vacío = identidad coherente). */
  contradictions: string[];
}

export interface ConsolidationCluster {
  key: string;
  canonicalFingerprint: string;
  canonicalUnitId: string;
  aliases: Array<{ fingerprint: string; unitId: string; reason: string }>;
  rationale: string;
  identity: CandidateIdentity;
}

export interface ConsolidationOutcome {
  clusters: ConsolidationCluster[];
  ungrouped: CandidateIdentityInput[];
  ambiguous: Array<{ fingerprint: string; reasons: string[] }>;
}

export type CandidateOperation = NonNullable<CandidateIdentity["operation"]>;
export type OperationFamily = "read" | "mutation" | "delete";
export type MissingControl =
  | "owner-check"
  | "identity-trust"
  | "input-validation"
  | "reference-validation"
  | "data-exposure";

/**
 * Tokeniza un slug para coincidencia por TOKEN COMPLETO (nunca por subcadena):
 * separa camelCase, normaliza a minúsculas y parte en caracteres no
 * alfanuméricos, conservando vocales acentuadas del vocabulario en español.
 */
function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9áéíóúüñ]+/)
    .filter((token) => token.length > 0);
}

const READ_TOKENS: ReadonlySet<string> = new Set(["read", "lectura", "get"]);
const WRITE_TOKENS: ReadonlySet<string> = new Set(["write", "escritura", "mutacion", "mutation"]);
const UPDATE_TOKENS: ReadonlySet<string> = new Set(["update", "upd"]);
const DELETE_TOKENS: ReadonlySet<string> = new Set(["delete", "borrado"]);

function familyOf(operation: CandidateOperation): OperationFamily {
  if (operation === "read") return "read";
  if (operation === "delete") return "delete";
  return "mutation";
}

/**
 * Operación declarada por UNA fuente de tokens (vocabulario cerrado). Varias
 * familias distintas en la misma fuente se consideran indeterminables: nunca
 * se elige por mayoría ni por orden de aparición.
 */
function operationFromTokens(
  tokens: readonly string[],
): { operation: CandidateOperation; family: OperationFamily } | null {
  const found = new Set<CandidateOperation>();
  for (const token of tokens) {
    if (READ_TOKENS.has(token)) found.add("read");
    else if (UPDATE_TOKENS.has(token)) found.add("update");
    else if (WRITE_TOKENS.has(token)) found.add("write");
    else if (DELETE_TOKENS.has(token)) found.add("delete");
  }
  const families = new Set<OperationFamily>([...found].map(familyOf));
  if (families.size !== 1) return null;
  if (found.has("read")) return { operation: "read", family: "read" };
  if (found.has("delete")) return { operation: "delete", family: "delete" };
  // Familia de mutación: "update" si hay token de actualización; "write" si
  // solo hay tokens de escritura.
  return found.has("update")
    ? { operation: "update", family: "mutation" }
    : { operation: "write", family: "mutation" };
}

/**
 * Variantes de cada control ausente como SECUENCIAS de tokens completos. El
 * nombre canónico del control también es variante válida. El orden de la lista
 * es el orden de evaluación (determinista).
 */
const MISSING_CONTROL_VARIANTS: ReadonlyArray<readonly [MissingControl, readonly string[]]> = [
  ["owner-check", ["missing", "owner", "check"]],
  ["owner-check", ["owner", "check"]],
  ["owner-check", ["owner"]],
  ["owner-check", ["propietario"]],
  ["owner-check", ["propietary"]],
  ["owner-check", ["sin", "comprobacion", "de", "propietario"]],
  ["identity-trust", ["authenticateduser"]],
  ["identity-trust", ["authenticated", "user"]],
  ["identity-trust", ["caller", "controlled", "identity"]],
  ["identity-trust", ["authentication", "context", "trust"]],
  ["identity-trust", ["principal", "trust"]],
  ["identity-trust", ["identity", "trust"]],
  ["input-validation", ["input", "validation"]],
  ["input-validation", ["validacion", "de", "entrada"]],
  ["input-validation", ["improper", "input", "validation"]],
  ["reference-validation", ["object", "reference", "validation"]],
  ["reference-validation", ["reference", "validation"]],
  ["reference-validation", ["bola"]],
  ["reference-validation", ["idor"]],
  ["data-exposure", ["data", "exposure"]],
];

function containsConsecutiveTokens(tokens: readonly string[], variant: readonly string[]): boolean {
  if (variant.length === 0 || variant.length > tokens.length) return false;
  for (let start = 0; start + variant.length <= tokens.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < variant.length; offset += 1) {
      if (tokens[start + offset] !== variant[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

function detectMissingControl(
  sources: ReadonlyArray<readonly string[]>,
): MissingControl | null {
  for (const [control, variant] of MISSING_CONTROL_VARIANTS) {
    for (const tokens of sources) {
      if (containsConsecutiveTokens(tokens, variant)) return control;
    }
  }
  return null;
}

/** Clase de ataque normalizada: mayúsculas y separadores como guiones. */
function normalizeAttackClass(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9ÑÁÉÍÓÚÜ]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Identidad estructural de un candidato, con contradicciones explícitas:
 * - `file`: exactamente una `startingPath`; si no, el prefijo de `surface`
 *   antes de `#`; si no hay, `null`.
 * - `operation`: derivada del slug (fingerprint+surface) y del boundary; si
 *   discrepan (familias distintas) queda `null` con la contradicción anotada.
 * - `missingControl`: vocabulario cerrado por tokens completos.
 */
export function classifyCandidateIdentity(input: CandidateIdentityInput): CandidateIdentity {
  const contradictions: string[] = [];

  let file: string | null = null;
  if (input.startingPaths.length === 1 && input.startingPaths[0] !== undefined && input.startingPaths[0].length > 0) {
    file = input.startingPaths[0];
  }
  if (file === null) {
    const hashIndex = input.surface.indexOf("#");
    const prefix = hashIndex >= 0 ? input.surface.slice(0, hashIndex) : input.surface;
    if (prefix.trim().length > 0) file = prefix;
  }

  const slugTokens = [...tokenize(input.fingerprint), ...tokenize(input.surface)];
  const boundaryTokens = tokenize(input.boundary);
  const slugOperation = operationFromTokens(slugTokens);
  const boundaryOperation = operationFromTokens(boundaryTokens);
  let operation: CandidateOperation | null;
  if (slugOperation !== null && boundaryOperation !== null) {
    if (slugOperation.family === boundaryOperation.family) {
      operation = slugOperation.operation;
    } else {
      operation = null;
      contradictions.push(`operation:slug=${slugOperation.operation}|boundary=${boundaryOperation.operation}`);
    }
  } else {
    operation = slugOperation?.operation ?? boundaryOperation?.operation ?? null;
  }

  const missingControl = detectMissingControl([
    tokenize(input.fingerprint),
    tokenize(input.surface),
    tokenize(input.boundary),
  ]);

  const attackClass = normalizeAttackClass(input.attackClass);
  return { file, operation, missingControl, attackClass, contradictions };
}

/**
 * Clave de consolidación: SOLO con identidad completa y sin contradicciones.
 * `JSON.stringify` de la lista fija el formato canónico y estable.
 */
export function consolidationKey(identity: CandidateIdentity): string | null {
  if (
    identity.file === null ||
    identity.operation === null ||
    identity.missingControl === null ||
    identity.attackClass.length === 0 ||
    identity.contradictions.length > 0
  ) {
    return null;
  }
  return JSON.stringify([identity.file, identity.operation, identity.missingControl, identity.attackClass]);
}

/** Exact equivalence of the complete observed hunter claim. No inference
 * from a slug, shared directory, or missing historical evidence. The source
 * location must be a concrete authorized file and line, and every other
 * candidate field (including trace/evidence when present) must match.
 */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return "{" + Object.keys(object).sort().map(k => JSON.stringify(k) + ":" + stableJson(object[k])).join(",") + "}";
  }
  return JSON.stringify(value) ?? "null";
}

export function exactCandidateEquivalenceKey(input: CandidateIdentityInput): string | null {
  const claim = input.candidate;
  if (!claim || claim.fingerprint !== input.fingerprint) return null;
  if (["title", "description", "location", "boundary", "impact"].some(k =>
    typeof claim[k] !== "string" || !(claim[k] as string).trim())) return null;
  const location = /^(.*):([1-9][0-9]*)$/.exec(String(claim.location));
  if (!location || !input.startingPaths.includes(location[1]!)) return null;
  const file = location[1]!;
  if (!file || file.startsWith("/") || file.split("/").some(p => !p || p === "." || p === "..")) return null;
  const coarse = consolidationKey(classifyCandidateIdentity(input));
  if (!coarse) return null;
  const { fingerprint: _fingerprint, ...body } = claim;
  return createHash("sha256").update(stableJson([file, location[2], input.boundary, input.subsystem,
    normalizeAttackClass(input.attackClass), [...input.startingPaths].sort(), coarse, body])).digest("hex");
}

const ALIAS_REASON = "hipótesis estructurada idéntica, misma ubicación concreta y frontera; pendiente de verificación canónica";

/** Número de evidencias declaradas por el registro del hunter (0 si no hay). */
function evidenceCount(candidate: Record<string, unknown> | null): number {
  if (candidate === null) return 0;
  return Array.isArray(candidate.evidence) ? candidate.evidence.length : 0;
}

/**
 * Comparador de canonicidad, independiente del orden de entrada:
 * 1. Con registro de hunter (`candidate !== null`) antes que sin registro.
 * 2. Con más entradas en `candidate.evidence` (array) antes que con menos.
 * 3. Fingerprint lexicográficamente menor.
 * 4. unitId lexicográficamente menor (desempate final, mismo fingerprint).
 */
function compareCanonical(a: CandidateIdentityInput, b: CandidateIdentityInput): number {
  const aRecord = a.candidate !== null ? 0 : 1;
  const bRecord = b.candidate !== null ? 0 : 1;
  if (aRecord !== bRecord) return aRecord - bRecord;
  const aEvidence = evidenceCount(a.candidate);
  const bEvidence = evidenceCount(b.candidate);
  if (aEvidence !== bEvidence) return bEvidence - aEvidence;
  if (a.fingerprint !== b.fingerprint) return a.fingerprint < b.fingerprint ? -1 : 1;
  if (a.unitId === b.unitId) return 0;
  return a.unitId < b.unitId ? -1 : 1;
}

/**
 * Valida UNA entrada de `consolidations` restaurada del estado de trabajo
 * (JSON simple). Una entrada corrupta devuelve `null` y se descarta: jamás se
 * reconstruyen clusters parciales ni identidades inventadas.
 */
export function parseConsolidationCluster(value: unknown): ConsolidationCluster | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const key = record.key;
  const canonicalFingerprint = record.canonicalFingerprint;
  const canonicalUnitId = record.canonicalUnitId;
  const rationale = record.rationale;
  if (typeof key !== "string" || key.length === 0) return null;
  if (typeof canonicalFingerprint !== "string" || canonicalFingerprint.length === 0) return null;
  if (typeof canonicalUnitId !== "string" || canonicalUnitId.length === 0) return null;
  if (typeof rationale !== "string") return null;
  const identityValue = record.identity;
  if (typeof identityValue !== "object" || identityValue === null || Array.isArray(identityValue)) return null;
  const identityRecord = identityValue as Record<string, unknown>;
  const file = identityRecord.file;
  const operation = identityRecord.operation;
  const missingControl = identityRecord.missingControl;
  const attackClass = identityRecord.attackClass;
  const contradictions = identityRecord.contradictions;
  if (file !== null && typeof file !== "string") return null;
  if (operation !== null && (typeof operation !== "string" || !["read", "write", "update", "delete"].includes(operation))) return null;
  if (missingControl !== null && (typeof missingControl !== "string" || missingControl.length === 0)) return null;
  if (typeof attackClass !== "string") return null;
  if (!Array.isArray(contradictions) || contradictions.some((entry) => typeof entry !== "string")) return null;
  if (!Array.isArray(record.aliases)) return null;
  const aliases: ConsolidationCluster["aliases"] = [];
  for (const entry of record.aliases) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
    const alias = entry as Record<string, unknown>;
    if (typeof alias.fingerprint !== "string" || alias.fingerprint.length === 0) return null;
    if (typeof alias.unitId !== "string" || alias.unitId.length === 0) return null;
    if (typeof alias.reason !== "string") return null;
    aliases.push({ fingerprint: alias.fingerprint, unitId: alias.unitId, reason: alias.reason });
  }
  if (aliases.length === 0) return null;
  return {
    key,
    canonicalFingerprint,
    canonicalUnitId,
    aliases,
    rationale,
    identity: {
      file,
      operation: operation as CandidateIdentity["operation"],
      missingControl,
      attackClass,
      contradictions: [...contradictions],
    },
  };
}

/**
 * Agrupa candidatos por clave de consolidación IDÉNTICA. Grupos de tamaño 1
 * vuelven a `ungrouped`; claves `null` (identidad incompleta o contradictoria)
 * van a `ambiguous` con sus razones. No hay ninguna heurística textual.
 */
export function consolidateCandidates(inputs: readonly CandidateIdentityInput[]): ConsolidationOutcome {
  const clusters: ConsolidationCluster[] = [];
  const ungrouped: CandidateIdentityInput[] = [];
  const ambiguous: Array<{ fingerprint: string; reasons: string[] }> = [];

  const byKey = new Map<string, CandidateIdentityInput[]>();
  for (const input of inputs) {
    if (input.fingerprint.length === 0) {
      ambiguous.push({ fingerprint: input.fingerprint, reasons: ["fingerprint vacío"] });
      continue;
    }
    const identity = classifyCandidateIdentity(input);
    const key = exactCandidateEquivalenceKey(input);
    if (key === null) {
      const reasons: string[] = [];
      if (identity.file === null) reasons.push("archivo indeterminable");
      if (identity.operation === null && identity.contradictions.length === 0) {
        reasons.push("operación indeterminable");
      }
      if (identity.missingControl === null) reasons.push("control ausente indeterminable");
      if (identity.attackClass.length === 0) reasons.push("clase de ataque vacía");
      reasons.push(...identity.contradictions);
      if (reasons.length === 0) reasons.push("falta una hipótesis original completa con ubicación y evidencia equivalentes");
      ambiguous.push({ fingerprint: input.fingerprint, reasons });
      continue;
    }
    const members = byKey.get(key);
    if (members) members.push(input);
    else byKey.set(key, [input]);
  }

  // Orden de salida determinista: claves y miembros ordenados por el
  // comparador de canonicidad, nunca por el orden de llegada.
  for (const key of [...byKey.keys()].sort()) {
    const members = byKey.get(key);
    if (!members) continue;
    const ordered = [...members].sort(compareCanonical);
    const canonical = ordered[0];
    if (!canonical) continue;
    if (ordered.length < 2) {
      ungrouped.push(...ordered);
      continue;
    }
    const identity = classifyCandidateIdentity(canonical);
    clusters.push({
      key,
      canonicalFingerprint: canonical.fingerprint,
      canonicalUnitId: canonical.unitId,
      aliases: ordered.slice(1).map((alias) => ({
        fingerprint: alias.fingerprint,
        unitId: alias.unitId,
        reason: ALIAS_REASON,
      })),
      rationale:
        `${ordered.length} candidatos comparten hipótesis estructurada, ubicación concreta, frontera y alcance ` +
        `(clave ${key}); se propone validar la canónica una sola vez; las alias permanecen pendientes hasta su aceptación final.`,
      identity,
    });
  }

  // `ungrouped` y `ambiguous` conservan el orden canónico de entrada recibida;
  // no afecta a ninguna decisión: son los que NO se agrupan.
  return { clusters, ungrouped, ambiguous };
}

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyCandidateIdentity,
  consolidationKey,
  exactCandidateEquivalenceKey,
  consolidateCandidates,
  type CandidateIdentityInput,
} from "./security-audit-consolidation.js";

const BROKEN_ACCESS = "ATTACK-CLASSES.md#BROKEN-ACCESS-CONTROL";

/**
 * Candidato realista del run c36e5d74: ausencia de comprobación de propietario
 * sobre `updateDocument` en `src/documents.js`, con la forma que produce el
 * orquestador (surface = superficie padre + `#` + fingerprint).
 */
function updateDocumentInput(
  fingerprint: string,
  overrides: Partial<CandidateIdentityInput> = {},
): CandidateIdentityInput {
  return {
    fingerprint,
    unitId: `unit-${fingerprint}`,
    surface: `src/documents.js#${fingerprint}`,
    boundary: "updateDocument-write",
    subsystem: "documents",
    attackClass: BROKEN_ACCESS,
    startingPaths: ["src/documents.js"],
    candidate: {
      fingerprint,
      title: "Actualización de documento sin comprobación de propietario",
      description: "Un atacante actualiza un documento ajeno.",
      location: "src/documents.js:42", boundary: "updateDocument-write", impact: "escritura ajena",
      evidence: [{ file: "src/documents.js", line: 42 }],
    },
    ...overrides,
  };
}

test("duplicate updateDocument candidates consolidate into one deterministic cluster", () => {
  const first = updateDocumentInput("bac-documents-update-document-missing-owner-check");
  const second = updateDocumentInput("documents-update-missing-owner-check");

  const identityFirst = classifyCandidateIdentity(first);
  assert.equal(identityFirst.file, "src/documents.js");
  assert.equal(identityFirst.operation, "update");
  assert.equal(identityFirst.missingControl, "owner-check");
  assert.equal(identityFirst.attackClass, "ATTACK-CLASSES-MD-BROKEN-ACCESS-CONTROL");
  assert.deepEqual(identityFirst.contradictions, []);
  assert.equal(consolidationKey(identityFirst), consolidationKey(classifyCandidateIdentity(second)));

  const forward = consolidateCandidates([first, second]);
  const backward = consolidateCandidates([second, first]);
  assert.equal(forward.clusters.length, 1);
  assert.equal(backward.clusters.length, 1);
  // Canónica determinista e independiente del orden: mismo tipo de registro y
  // misma evidencia ⇒ gana el fingerprint lexicográficamente menor.
  assert.equal(forward.clusters[0]?.canonicalFingerprint, "bac-documents-update-document-missing-owner-check");
  assert.equal(backward.clusters[0]?.canonicalFingerprint, "bac-documents-update-document-missing-owner-check");
  assert.deepEqual(
    forward.clusters[0]?.aliases.map((alias) => alias.fingerprint),
    ["documents-update-missing-owner-check"],
  );
  assert.equal(forward.ungrouped.length, 0);
  assert.equal(forward.ambiguous.length, 0);
});

test("absent original claim or different evidence cannot be merged", () => {
  const first = updateDocumentInput("bac-documents-update-document-missing-owner-check");
  const second = updateDocumentInput("documents-update-missing-owner-check");
  const absent = {...second, candidate:null};
  assert.equal(consolidateCandidates([first, absent]).clusters.length,0);
  const distinct = {...second, candidate:{...second.candidate,location:"src/documents.js:71"}};
  assert.equal(consolidateCandidates([first,distinct]).clusters.length,0);
  const differentEvidence = {...second,candidate:{...second.candidate,evidence:[{file:"src/documents.js",line:42,description:"control present"}]}};
  assert.equal(consolidateCandidates([first,differentEvidence]).clusters.length,0);
  const differentBoundary = {...second,boundary:"updateOtherDocument-write"};
  assert.equal(consolidateCandidates([first,differentBoundary]).clusters.length,0);
  const otherPaths = {...second,startingPaths:["src/documents.js","src/orders.js"]};
  assert.equal(consolidateCandidates([first,otherPaths]).clusters.length,0);
  assert.equal(exactCandidateEquivalenceKey({...second,startingPaths:["src"]}),null);
});

test("file comes from a single starting path, else from the surface prefix before '#'", () => {
  const single = classifyCandidateIdentity(updateDocumentInput("documents-update-missing-owner-check"));
  assert.equal(single.file, "src/documents.js");
  const withoutPaths = classifyCandidateIdentity(
    updateDocumentInput("documents-update-missing-owner-check", { startingPaths: [] }),
  );
  assert.equal(withoutPaths.file, "src/documents.js");
  const severalPaths = classifyCandidateIdentity(
    updateDocumentInput("documents-update-missing-owner-check", {
      startingPaths: ["src/documents.js", "src/orders.js"],
    }),
  );
  assert.equal(severalPaths.file, "src/documents.js");
  const unusableSurface = classifyCandidateIdentity(
    updateDocumentInput("documents-update-missing-owner-check", {
      startingPaths: [],
      surface: "#documents-update-missing-owner-check",
    }),
  );
  assert.equal(unusableSurface.file, null);
});

test("different files, operations or attack classes are never grouped", () => {
  const base = updateDocumentInput("documents-update-missing-owner-check");
  const otherFile = updateDocumentInput("documents-update-missing-owner-check", {
    startingPaths: ["src/orders.js"],
    surface: "src/orders.js#documents-update-missing-owner-check",
  });
  const otherOperation = updateDocumentInput("documents-read-missing-owner-check", {
    boundary: "getDocument-read",
  });
  const otherAttackClass = updateDocumentInput("documents-update-missing-owner-check", {
    attackClass: "ATTACK-CLASSES.md#INJECTION",
  });

  const baseKey = consolidationKey(classifyCandidateIdentity(base));
  assert.notEqual(baseKey, consolidationKey(classifyCandidateIdentity(otherFile)));
  assert.notEqual(baseKey, consolidationKey(classifyCandidateIdentity(otherOperation)));
  assert.notEqual(baseKey, consolidationKey(classifyCandidateIdentity(otherAttackClass)));
  assert.equal(classifyCandidateIdentity(otherOperation).operation, "read");

  const result = consolidateCandidates([base, otherFile, otherOperation, otherAttackClass]);
  assert.equal(result.clusters.length, 0);
  assert.equal(result.ungrouped.length + result.ambiguous.length, 4);
});

test("contradictory evidence (update slug, read boundary) stays ambiguous without grouping", () => {
  const contradictory = updateDocumentInput("documents-update-missing-owner-check", {
    boundary: "getDocument",
  });
  const identity = classifyCandidateIdentity(contradictory);
  assert.equal(identity.operation, null);
  assert.deepEqual(identity.contradictions, ["operation:slug=update|boundary=read"]);
  assert.equal(consolidationKey(identity), null);

  const plain = updateDocumentInput("bac-documents-update-document-missing-owner-check");
  const result = consolidateCandidates([contradictory, plain]);
  assert.equal(result.clusters.length, 0);
  assert.equal(result.ungrouped.length, 1, "el candidato coherente queda sin agrupar, no fusionado");
  assert.equal(result.ambiguous.length, 1);
  assert.equal(result.ambiguous[0]?.fingerprint, "documents-update-missing-owner-check");
  assert.ok(
    result.ambiguous[0]?.reasons.some((reason) => reason.includes("operation:slug=update|boundary=read")),
  );
});

test("candidates without a determinable control or operation are ambiguous with reasons", () => {
  const noControl = updateDocumentInput("documents-update-requiere-atencion");
  const noOperation = updateDocumentInput("documents-missing-owner-check", {
    boundary: "src/documents.js#trust-boundary",
  });
  const result = consolidateCandidates([noControl, noOperation]);
  assert.equal(result.clusters.length, 0);
  assert.equal(result.ambiguous.length, 2);
  const reasons = result.ambiguous.flatMap((entry) => entry.reasons);
  assert.ok(reasons.some((reason) => reason.includes("control ausente indeterminable")));
  assert.ok(reasons.some((reason) => reason.includes("operación indeterminable")));
  // Coincidencia por token completo: "ownerless" NO revela "owner".
  const ownerless = classifyCandidateIdentity(updateDocumentInput("documents-update-ownerless-write"));
  assert.equal(ownerless.missingControl, null);
  assert.equal(consolidationKey(ownerless), null);
});

test("near-identical titles are never grouped when file or missing control differ", () => {
  const sameTitle = "Actualización de documento sin comprobación de propietario";
  const orders = updateDocumentInput("documents-update-missing-owner-check", {
    startingPaths: ["src/orders.js"],
    surface: "src/orders.js#documents-update-missing-owner-check",
    candidate: { fingerprint: "documents-update-missing-owner-check", title: sameTitle, evidence: [] },
  });
  const documents = updateDocumentInput("documents-update-missing-owner-check-dos", {
    candidate: { fingerprint: "documents-update-missing-owner-check-dos", title: sameTitle, evidence: [] },
  });
  const identityVariant = updateDocumentInput("documents-update-missing-identity-trust", {
    candidate: { fingerprint: "documents-update-missing-identity-trust", title: sameTitle, evidence: [] },
  });

  assert.equal(classifyCandidateIdentity(identityVariant).missingControl, "identity-trust");
  const documentsKey = consolidationKey(classifyCandidateIdentity(documents));
  assert.notEqual(documentsKey, consolidationKey(classifyCandidateIdentity(orders)));
  assert.notEqual(documentsKey, consolidationKey(classifyCandidateIdentity(identityVariant)));

  const result = consolidateCandidates([orders, documents, identityVariant]);
  assert.equal(result.clusters.length, 0, "parecidos textuales nunca se agrupan");
  assert.equal(result.ungrouped.length + result.ambiguous.length, 3);
});

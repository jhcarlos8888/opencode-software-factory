import assert from "node:assert/strict";
import { test } from "node:test";
import { parseOpenCodeFormAnswers } from "./opencode-forms.js";

const multiSelectForm = {
  id: "frm_test",
  metadata: {
    fields: [{
      key: "q0",
      title: "Autorización de pruebas",
      description: "Selecciona las comprobaciones que autorizas.",
      type: "multiselect",
      options: [
        { value: "npm run check", label: "npm run check" },
        { value: "npm run smoke", label: "npm run smoke" },
        { value: "static", label: "Solo informe estático" }
      ],
      required: true,
      minItems: 1,
      maxItems: 3,
      custom: true
    }]
  }
};

test("OpenCode multiselect accepts selected option values as a string array", () => {
  assert.deepEqual(parseOpenCodeFormAnswers(multiSelectForm, JSON.stringify({
    q0: ["npm run check", "npm run smoke"]
  })), {
    q0: ["npm run check", "npm run smoke"]
  });
});

test("OpenCode multiselect rejects free text instead of converting it to a string", () => {
  assert.throws(
    () => parseOpenCodeFormAnswers(multiSelectForm, "Sí, ejecutar check y smoke"),
    /respuestas estructuradas/
  );
});

test("OpenCode multiselect rejects an option outside the form schema", () => {
  assert.throws(
    () => parseOpenCodeFormAnswers({
      fields: [{ key: "q0", type: "multiselect", required: true, options: [
        { value: "npm run check", label: "npm run check" },
        { value: "npm run smoke", label: "npm run smoke" }
      ], custom: false }]
    }, { q0: ["npm run check", "rm -rf /"] }),
    /no pertenece al campo q0/
  );
});

test("OpenCode multiselect enforces the required minimum and maximum", () => {
  assert.throws(() => parseOpenCodeFormAnswers(multiSelectForm, { q0: [] }), /al menos 1 opción/);
  assert.throws(() => parseOpenCodeFormAnswers(multiSelectForm, { q0: ["a", "b", "c", "d"] }), /como máximo 3/);
});

test("OpenCode validates string, number, integer and boolean fields with native types", () => {
  const form = {
    fields: [
      { key: "name", type: "string", required: true, minLength: 2, maxLength: 10 },
      { key: "temperature", type: "number", required: true, minimum: 0, maximum: 2 },
      { key: "count", type: "integer", required: true, minimum: 1, maximum: 5 },
      { key: "confirmed", type: "boolean", required: true }
    ]
  };
  assert.deepEqual(parseOpenCodeFormAnswers(form, {
    name: "Build",
    temperature: 0.5,
    count: 3,
    confirmed: true
  }), {
    name: "Build",
    temperature: 0.5,
    count: 3,
    confirmed: true
  });
  assert.throws(() => parseOpenCodeFormAnswers(form, {
    name: "x", temperature: 0.5, count: 3, confirmed: true
  }), /al menos 2 caracteres/);
  assert.throws(() => parseOpenCodeFormAnswers(form, {
    name: "Build", temperature: 2.5, count: 3, confirmed: true
  }), /máximo de temperature/);
  assert.throws(() => parseOpenCodeFormAnswers(form, {
    name: "Build", temperature: 0.5, count: 1.5, confirmed: true
  }), /número entero/);
  assert.throws(() => parseOpenCodeFormAnswers(form, {
    name: "Build", temperature: 0.5, count: 3, confirmed: "sí"
  }), /verdadero o falso/);
});

test("OpenCode string choices enforce option values unless custom answers are allowed", () => {
  const form = { fields: [{ key: "mode", type: "string", options: [
    { value: "read-only", label: "Solo lectura" },
    { value: "write", label: "Escritura" }
  ] }] };
  assert.deepEqual(parseOpenCodeFormAnswers(form, { mode: "read-only" }), { mode: "read-only" });
  assert.throws(() => parseOpenCodeFormAnswers(form, { mode: "admin" }), /opción válida/);
  assert.deepEqual(parseOpenCodeFormAnswers({ fields: [{
    key: "mode", type: "string", custom: true, options: [{ value: "read-only", label: "Solo lectura" }]
  }] }, { mode: "my-custom-mode" }), { mode: "my-custom-mode" });
});

test("OpenCode conditions hide irrelevant required fields and external fields stay informational", () => {
  const form = { fields: [
    { key: "include", type: "boolean", required: true },
    { key: "reason", type: "string", required: true, when: [{ key: "include", op: "eq", value: true }] },
    { key: "reference", type: "external", url: "https://example.test", title: "Documentación" }
  ] };
  assert.deepEqual(parseOpenCodeFormAnswers(form, { include: false }), { include: false });
  assert.deepEqual(parseOpenCodeFormAnswers(form, { include: true, reason: "Necesario" }), {
    include: true, reason: "Necesario"
  });
  assert.throws(() => parseOpenCodeFormAnswers(form, { include: true }), /Completa el campo reason/);
});

test("OpenCode rejects unknown fields and malformed answer objects", () => {
  const form = { fields: [{ key: "q0", type: "boolean" }] };
  assert.throws(() => parseOpenCodeFormAnswers(form, { q0: true, rogue: "x" }), /no pertenece al formulario/);
  assert.throws(() => parseOpenCodeFormAnswers(form, "true"), /debe ser un objeto/);
});

test("OpenCode Form.Info fields are accepted beside metadata and through the factory decision wrapper", () => {
  const fields = [{ key: "mode", type: "string", options: [
    { value: "quick", label: "Rápido" }, { value: "deep", label: "Profundo" }
  ] }];
  assert.deepEqual(parseOpenCodeFormAnswers({
    id: "form-info", title: "Choose mode", metadata: { kind: "question" }, fields
  }, { mode: "deep" }), { mode: "deep" });
  assert.deepEqual(parseOpenCodeFormAnswers({
    id: "decision", permission: "question", metadata: {
      id: "form-info", fields, metadata: { kind: "question" }
    }
  }, { mode: "quick" }), { mode: "quick" });
});

test("OpenCode custom multiselect counts custom values and rejects duplicates", () => {
  const form = { fields: [{
    key: "targets", type: "multiselect", required: true, minItems: 1, maxItems: 2,
    custom: true, options: [{ value: "check" }, { value: "smoke" }]
  }] };
  assert.deepEqual(parseOpenCodeFormAnswers(form, { targets: ["check", "my custom target"] }), {
    targets: ["check", "my custom target"]
  });
  assert.throws(() => parseOpenCodeFormAnswers(form, { targets: ["check", "smoke", "third"] }), /como máximo 2/);
  assert.throws(() => parseOpenCodeFormAnswers(form, { targets: ["check", "check"] }), /duplicadas/);
});

test("OpenCode external fields are informational and excluded from answer payloads", () => {
  const form = { fields: [
    { key: "docs", type: "external", title: "Documentación", url: "https://example.test" },
    { key: "approved", type: "boolean", required: true }
  ] };
  assert.deepEqual(parseOpenCodeFormAnswers(form, { approved: true }), { approved: true });
});


test("OpenCode string choice aliases are normalized as string answers", () => {
  const form = { fields: [
    { key: "choice", type: "select", options: [{ value: "one" }, { value: "two" }] },
    { key: "notes", type: "textarea", required: true }
  ] };
  assert.deepEqual(parseOpenCodeFormAnswers(form, { choice: "two", notes: "details" }), {
    choice: "two", notes: "details"
  });
  assert.throws(() => parseOpenCodeFormAnswers(form, { choice: "invalid", notes: "details" }), /opción válida/);
});

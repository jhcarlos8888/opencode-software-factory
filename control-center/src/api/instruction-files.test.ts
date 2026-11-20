import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { planTask } from "./task-planner.js";
import {
  MAX_FILES_PER_WORK_THREAD, MAX_INSTRUCTION_FILE_BYTES,
  formatInstructionFilePrompt, validateInstructionFile
} from "./instruction-files.js";

test("a long UTF-8 TXT is accepted intact, beyond chat's 24k character limit", () => {
  const content = "Sección investigación\n".repeat(4000);
  const file = validateInstructionFile({ name: "plan-de-trabajo.txt", content });
  assert.ok(file);
  assert.equal(file.content, content);
  assert.equal(file.byteLength, Buffer.byteLength(content));
  assert.equal(file.sha256, createHash("sha256").update(content).digest("hex"));
  assert.ok(file.byteLength > 24_000);
  assert.equal(MAX_INSTRUCTION_FILE_BYTES, 131072);
  assert.equal(MAX_FILES_PER_WORK_THREAD, 8);
});

test("oversize TXT, empty files, binary, wrong extension and path traversal fail before persistence", () => {
  assert.equal(validateInstructionFile(null), null);
  for (const input of [
    { name: "../secrets.txt", content: "a" },
    { name: "/tmp/secret.txt", content: "a" },
    { name: "archivo.pdf", content: "a" },
    { name: "archivo.txt", content: "" },
    { name: "archivo.txt", content: "\u0000" },
    { name: "archivo.txt", content: "abc\ufffd" },
    { name: "archivo.txt", content: "\ud800" },
    { name: "archivo.txt", content: "x".repeat(131073) },
    { name: "archivo.txt", content: "á".repeat(65537) },
    { name: "archivo.txt", content: Buffer.from([0x00, 0x01]) },
    "archivo.txt"
  ]) assert.throws(() => validateInstructionFile(input), Error, JSON.stringify(input).slice(0, 40));
});

test("exact 128KiB boundary is accepted without truncation", () => {
  const content = "α".repeat(65536);
  const file = validateInstructionFile({ name: "LARGO.TXT", content });
  assert.equal(file?.byteLength, MAX_INSTRUCTION_FILE_BYTES);
  assert.equal(file?.content, content);
});

test("agent prompt receives complete TXT content and provenance, including last byte", () => {
  const content = "Primero analiza.\n" + "Q".repeat(80000) + "\nÚLTIMA_INSTRUCCIÓN_CONFIRMADA";
  const valid = validateInstructionFile({ name: "plan.txt", content })!;
  const prompt = formatInstructionFilePrompt([{
    ...valid, id: "file-1", threadId: "thread-1", roundNumber: 1,
    createdAt: "2026-11-19T00:00:00.000Z"
  }]);
  assert.ok(prompt.includes(content));
  assert.ok(prompt.includes("ÚLTIMA_INSTRUCCIÓN_CONFIRMADA"));
  assert.ok(prompt.includes(valid.sha256));
  assert.ok(prompt.includes("--- FIN DEL ARCHIVO TXT file-1 ---"));
  assert.equal(formatInstructionFilePrompt([]), "");
});


test("task planner classifies the actual TXT instructions, not the generic file-upload wrapper", () => {
  const wrapper = "Mi petición está definida en el archivo TXT adjunto. Léelo íntegramente y sigue su contenido para esta ronda: plan.txt.";
  const explanation = planTask(wrapper + "\nExplica la arquitectura general del proyecto en un párrafo.");
  assert.equal(explanation.kind, "explanation");
  assert.equal(explanation.changesExpected, false);
  const change = planTask(wrapper + "\nImplementa un nuevo validador en public/app.js y verifica las pruebas.");
  assert.equal(change.kind, "implementation");
  assert.equal(change.changesExpected, true);
});

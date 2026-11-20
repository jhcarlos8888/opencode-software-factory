import { createHash } from "node:crypto";
import { MAX_INSTRUCTION_FILE_BYTES } from "./work-instruction-limit.js";
export { MAX_INSTRUCTION_FILE_BYTES } from "./work-instruction-limit.js";

/** TXT files are intentionally distinct from the 24,000-character chat box. */
export const MAX_FILES_PER_WORK_THREAD = 8;

export interface IncomingInstructionFile {
  name: string;
  content: string;
}

export interface ValidInstructionFile extends IncomingInstructionFile {
  byteLength: number;
  sha256: string;
}

export interface StoredInstructionFile extends ValidInstructionFile {
  id: string;
  threadId: string;
  roundNumber: number;
  createdAt: string;
}

export type InstructionFileMetadata = Omit<StoredInstructionFile, "content">;

export function validateInstructionFile(candidate: unknown): ValidInstructionFile | null {
  if (candidate === null || candidate === undefined) return null;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("El archivo de instrucciones debe ser un documento TXT válido.");
  }
  const { name, content } = candidate as Record<string, unknown>;
  if (typeof name !== "string" ||
      name.length > 120 || name.length < 5 ||
      !/\.txt$/i.test(name) || name === ".." ||
      /[/\\\x00-\x1f\x7f]/.test(name)) {
    throw new Error("Selecciona un archivo .txt con un nombre válido (máximo 120 caracteres).");
  }
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("El archivo TXT debe contener instrucciones de texto legibles.");
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(content) || content.includes("\ufffd")) {
    throw new Error("El archivo contiene datos binarios o texto con codificación inválida; utiliza UTF-8.");
  }
  // Invalid unmatched UTF-16 surrogates must not silently turn into U+FFFD
  // when serialized to UTF-8. The original text must be byte-for-byte roundtrippable.
  if (Buffer.from(content, "utf8").toString("utf8") !== content) {
    throw new Error("El TXT contiene caracteres Unicode no válidos. Guárdalo en UTF-8.");
  }
  // This is a size *boundary*, not a content truncation. Either the whole file
  // is stored and delivered, or the request fails with a clear error.
  const byteLength = Buffer.byteLength(content, "utf8");
  if (byteLength > MAX_INSTRUCTION_FILE_BYTES) {
    throw new Error("El archivo TXT supera el límite de 128 KiB. Divídelo en secciones antes de cargarlo.");
  }
  return {
    name, content, byteLength,
    sha256: createHash("sha256").update(content, "utf8").digest("hex")
  };
}

export function formatInstructionFilePrompt(files: readonly StoredInstructionFile[]): string {
  if (!files.length) return "";
  const sections = [
    "ARCHIVOS TXT DE INSTRUCCIONES DEL USUARIO — CONTENIDO ÍNTEGRO",
    "Estos archivos fueron seleccionados expresamente para ESTA ronda y son parte de la petición del usuario.",
    "Lee TODOS sus apartados antes de trabajar. No omitas bloques ni afirmes haberlos leído si el motor no puede procesarlos íntegramente.",
    "Los archivos anteriores no seleccionados no se reejecutan automáticamente; el historial sigue disponible."
  ];
  for (const file of files) {
    sections.push(
      "",
      `--- INICIO DEL ARCHIVO TXT ${file.id} ---`,
      `Nombre original: ${file.name}`,
      `Tamaño exacto UTF-8: ${file.byteLength} bytes`,
      `SHA-256: ${file.sha256}`,
      `Origen: ronda ${file.roundNumber} del proceso ${file.threadId}`,
      "CONTENIDO COMPLETO:",
      file.content,
      `--- FIN DEL ARCHIVO TXT ${file.id} ---`
    );
  }
  return sections.join("\n");
}

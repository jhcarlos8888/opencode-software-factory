export type OpenCodeFormValue = string | number | boolean | string[];
export type OpenCodeFormAnswers = Record<string, OpenCodeFormValue>;

type FormOption = { value: string; label?: string };
type FormField = {
  key: string;
  type: string;
  required?: boolean;
  hidden?: boolean;
  when?: Array<{ key: string; op: "eq" | "neq"; value: string | number | boolean }>;
  options?: FormOption[];
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  format?: string;
  custom?: boolean;
  default?: unknown;
  title?: string;
  description?: string;
  url?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function formFieldsFrom(details: unknown): FormField[] {
  if (!isRecord(details)) throw new Error("OpenCode no proporcionó el formulario en un formato válido.");
  const metadata = isRecord(details.metadata) ? details.metadata : null;
  const nestedMetadata = metadata && isRecord(metadata.metadata) ? metadata.metadata : null;
  const fieldContainer = [details, metadata, nestedMetadata]
    .find((candidate): candidate is Record<string, unknown> => candidate !== null && Array.isArray(candidate.fields));
  if (!fieldContainer || !Array.isArray(fieldContainer.fields)) {
    throw new Error("OpenCode no proporcionó la lista de campos del formulario.");
  }

  return fieldContainer.fields.map((raw, index) => {
    if (!isRecord(raw) || typeof raw.key !== "string" || !raw.key.trim() || typeof raw.type !== "string") {
      throw new Error("El campo " + (index + 1) + " del formulario no tiene clave o tipo válido.");
    }
    const options = Array.isArray(raw.options)
      ? raw.options.map((option, optionIndex) => {
          if (!isRecord(option) || typeof option.value !== "string") {
            throw new Error("Una opción del campo " + raw.key + " no tiene un valor de texto válido (opción " + (optionIndex + 1) + ").");
          }
          return { value: option.value, label: typeof option.label === "string" ? option.label : undefined };
        })
      : undefined;
    const when = Array.isArray(raw.when)
      ? raw.when.map((condition) => {
          if (!isRecord(condition) || typeof condition.key !== "string" ||
              !["eq", "neq"].includes(String(condition.op))) {
            throw new Error("El campo " + raw.key + " contiene una condición no válida.");
          }
          return {
            key: condition.key,
            op: condition.op as "eq" | "neq",
            value: condition.value as string | number | boolean
          };
        })
      : undefined;
    return {
      key: raw.key,
      type: raw.type,
      required: typeof raw.required === "boolean" ? raw.required : undefined,
      hidden: raw.hidden === true,
      when,
      options,
      minItems: typeof raw.minItems === "number" ? raw.minItems : undefined,
      maxItems: typeof raw.maxItems === "number" ? raw.maxItems : undefined,
      minLength: typeof raw.minLength === "number" ? raw.minLength : undefined,
      maxLength: typeof raw.maxLength === "number" ? raw.maxLength : undefined,
      minimum: typeof raw.minimum === "number" ? raw.minimum : undefined,
      maximum: typeof raw.maximum === "number" ? raw.maximum : undefined,
      pattern: typeof raw.pattern === "string" ? raw.pattern : undefined,
      format: typeof raw.format === "string" ? raw.format : undefined,
      custom: raw.custom === true,
      default: raw.default,
      title: typeof raw.title === "string" ? raw.title : undefined,
      description: typeof raw.description === "string" ? raw.description : undefined,
      url: typeof raw.url === "string" ? raw.url : undefined
    };
  });
}

function parseRawAnswers(answer: string | Record<string, unknown>): Record<string, unknown> {
  if (typeof answer !== "string") return answer;
  try {
    const parsed: unknown = JSON.parse(answer);
    if (!isRecord(parsed)) throw new Error("La respuesta estructurada debe ser un objeto con una clave por campo.");
    return parsed;
  } catch (error) {
    if (error instanceof Error && error.message === "La respuesta estructurada debe ser un objeto con una clave por campo.") throw error;
    throw new Error("El formulario requiere respuestas estructuradas. Selecciona las opciones y vuelve a enviarlas desde el formulario.");
  }
}

function isVisible(field: FormField, answers: Record<string, unknown>): boolean {
  if (field.hidden) return false;
  return (field.when ?? []).every((condition) => {
    const matches = answers[condition.key] === condition.value;
    return condition.op === "neq" ? !matches : matches;
  });
}

function validateValue(field: FormField, value: unknown): OpenCodeFormValue | undefined {
  const required = field.required !== false;
  const label = field.key;
  const type = field.type.toLowerCase();
  switch (type) {
    case "external":
      // External fields are informational links, not answer-bearing fields.
      return undefined;
    case "multiselect": {
      if (value === undefined && field.default !== undefined) value = field.default;
      if (value === undefined && !required) return undefined;
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        throw new Error("El campo " + label + " requiere una lista de opciones, no un texto.");
      }
      const selected = value as string[];
      if (new Set(selected).size !== selected.length) {
        throw new Error("El campo " + label + " contiene opciones duplicadas.");
      }
      const minimum = field.minItems ?? (required ? 1 : 0);
      if (selected.length < minimum) throw new Error("Selecciona al menos " + minimum + " opción(es) en " + label + ".");
      if (field.maxItems !== undefined && selected.length > field.maxItems) {
        throw new Error("Selecciona como máximo " + field.maxItems + " opción(es) en " + label + ".");
      }
      if (!field.custom) {
        const allowed = new Set((field.options ?? []).map((option) => option.value));
        const invalid = selected.find((item) => !allowed.has(item));
        if (invalid !== undefined) throw new Error("La opción seleccionada no pertenece al campo " + label + ".");
      }
      return selected;
    }
    case "string":
    case "select":
    case "radio":
    case "enum":
    case "textarea":
    case "text-area":
    case "long-text": {
      if (value === undefined && field.default !== undefined) value = field.default;
      if (value === undefined || value === null || value === "") {
        if (!required) return undefined;
        throw new Error("Completa el campo " + label + ".");
      }
      if (typeof value !== "string") throw new Error("El campo " + label + " debe ser texto.");
      if (field.minLength !== undefined && value.length < field.minLength) {
        throw new Error("El campo " + label + " debe contener al menos " + field.minLength + " caracteres.");
      }
      if (field.maxLength !== undefined && value.length > field.maxLength) {
        throw new Error("El campo " + label + " admite como máximo " + field.maxLength + " caracteres.");
      }
      if (field.pattern) {
        let pattern: RegExp;
        try { pattern = new RegExp(field.pattern); }
        catch { throw new Error("El patrón de validación del campo " + label + " no es válido."); }
        if (!pattern.test(value)) throw new Error("El formato del campo " + label + " no es válido.");
      }
      if (field.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        throw new Error("Introduce un correo válido en " + label + ".");
      }
      if (field.format === "uri") {
        try { new URL(value); } catch { throw new Error("Introduce una URL válida en " + label + "."); }
      }
      if (field.options?.length && !field.custom && !field.options.some((option) => option.value === value)) {
        throw new Error("Selecciona una opción válida en " + label + ".");
      }
      return value;
    }
    case "number":
    case "integer": {
      if (value === undefined && field.default !== undefined) value = field.default;
      if (value === undefined || value === null || value === "") {
        if (!required) return undefined;
        throw new Error("Introduce un número en " + label + ".");
      }
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error("El campo " + label + " debe ser un número válido.");
      }
      if (type === "integer" && !Number.isInteger(value)) {
        throw new Error("El campo " + label + " debe ser un número entero.");
      }
      if (field.minimum !== undefined && value < field.minimum) {
        throw new Error("El valor mínimo de " + label + " es " + field.minimum + ".");
      }
      if (field.maximum !== undefined && value > field.maximum) {
        throw new Error("El valor máximo de " + label + " es " + field.maximum + ".");
      }
      return value;
    }
    case "boolean": {
      if (value === undefined && field.default !== undefined) value = field.default;
      if (value === undefined && !required) return false;
      if (typeof value !== "boolean") throw new Error("El campo " + label + " debe ser verdadero o falso.");
      return value;
    }
    default:
      throw new Error("OpenCode envió un tipo de campo no compatible: " + field.type + ".");
  }
}

/**
 * Validate and normalize an OpenCode Form.Reply answer against the actual
 * form fields before forwarding it to the OpenCode session.
 */
export function parseOpenCodeFormAnswers(
  details: unknown,
  answer: string | Record<string, unknown>
): OpenCodeFormAnswers {
  const fields = formFieldsFrom(details);
  const raw = parseRawAnswers(answer);
  const knownKeys = new Set(fields.map((field) => field.key));
  const unexpected = Object.keys(raw).find((key) => !knownKeys.has(key));
  if (unexpected) throw new Error("La respuesta incluye un campo que no pertenece al formulario: " + unexpected + ".");

  const normalized: OpenCodeFormAnswers = {};
  const resolved: Record<string, unknown> = {};
  for (const field of fields) {
    if (!isVisible(field, { ...raw, ...resolved })) continue;
    if (field.type === "external") continue;
    const value = validateValue(field, raw[field.key]);
    if (value !== undefined) {
      normalized[field.key] = value;
      resolved[field.key] = value;
    }
  }
  return normalized;
}

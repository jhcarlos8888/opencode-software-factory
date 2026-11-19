import React, { useEffect, useMemo, useState } from "react";

export interface OpenCodeFormOption {
  value: string;
  label?: string;
  description?: string;
}

export interface OpenCodeFormField {
  key: string;
  title?: string;
  description?: string;
  type: string;
  url?: string;
  options?: OpenCodeFormOption[];
  required?: boolean;
  default?: unknown;
  defaultValue?: unknown;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  multiple?: boolean;
  custom?: boolean;
  when?: unknown;
  hidden?: boolean;
  format?: string;
  pattern?: string;
  placeholder?: string;
}

type FormValues = Record<string, unknown>;

interface OpenCodeQuestionFormProps {
  fields: OpenCodeFormField[];
  busy?: boolean;
  onSubmit: (answers: FormValues) => void;
}

const CUSTOM_OPTION = "__factory_custom_answer__";

function initialValues(fields: OpenCodeFormField[]): FormValues {
  const values: FormValues = {};
  for (const field of fields) {
    const value = field.defaultValue ?? field.default;
    if (value !== undefined) values[field.key] = value;
    else if (field.type === "multiselect" || field.multiple) values[field.key] = [];
    else if (["boolean", "confirm", "checkbox"].includes(field.type)) values[field.key] = false;
    else if (["number", "integer"].includes(field.type)) values[field.key] = "";
    else values[field.key] = "";
  }
  return values;
}

function normalizeConditions(when: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(when)) return when.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
  if (when && typeof when === "object") return [when as Record<string, unknown>];
  return [];
}

function isFieldVisible(field: OpenCodeFormField, values: FormValues): boolean {
  if (field.hidden) return false;
  const conditions = normalizeConditions(field.when);
  return conditions.every((condition) => {
    const key = String(condition.key ?? condition.field ?? "");
    if (!key) return true;
    const actual = values[key];
    const expected = condition.value;
    const operator = String(condition.op ?? condition.operator ?? "equals").toLowerCase();
    if (["neq", "not-equals", "not_equals", "!="].includes(operator)) return actual !== expected;
    if (["in", "includes"].includes(operator)) return Array.isArray(expected) && expected.includes(actual);
    if (["not-in", "not_in"].includes(operator)) return Array.isArray(expected) && !expected.includes(actual);
    if (["truthy", "exists"].includes(operator)) return Boolean(actual);
    if (["falsy", "not-exists"].includes(operator)) return !actual;
    return actual === expected;
  });
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function safeExternalUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function validateField(field: OpenCodeFormField, value: unknown, customValue = ""): string | null {
  const required = field.required !== false;
  const type = field.type.toLowerCase();
  if (type === "external") return null;

  if (type === "multiselect" || field.multiple) {
    const selected = asStringArray(value);
    const custom = field.custom ? customValue.trim() : "";
    const effective = custom ? [...selected, custom] : selected;
    const minimum = field.minItems ?? (required ? 1 : 0);
    if (effective.length < minimum) return "Selecciona al menos " + minimum + " opción(es).";
    if (field.maxItems !== undefined && effective.length > field.maxItems) return "Selecciona como máximo " + field.maxItems + " opción(es).";
    if (new Set(effective).size !== effective.length) return "Hay opciones duplicadas en la selección.";
    const allowed = new Set((field.options ?? []).map((option) => option.value));
    if (selected.some((item) => !allowed.has(item)) && !field.custom) return "Hay una opción que ya no está disponible.";
    return null;
  }

  if (["boolean", "confirm", "checkbox"].includes(type)) {
    if (required && typeof value !== "boolean") return "Selecciona una respuesta.";
    return null;
  }

  if (["number", "integer"].includes(type)) {
    if ((value === "" || value === null || value === undefined) && !required) return null;
    const number = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(number)) return "Introduce un número válido.";
    if (type === "integer" && !Number.isInteger(number)) return "Introduce un número entero.";
    if (field.minimum !== undefined && number < field.minimum) return "El valor mínimo es " + field.minimum + ".";
    if (field.maximum !== undefined && number > field.maximum) return "El valor máximo es " + field.maximum + ".";
    return null;
  }

  const isSingleChoice = ["select", "radio", "enum"].includes(type) ||
    (type === "string" && (field.options?.length ?? 0) > 0);
  const customChoice = isSingleChoice && field.custom && value === CUSTOM_OPTION;
  const text = customChoice ? customValue.trim() : typeof value === "string" ? value : String(value ?? "");
  if (required && !text.trim()) return customChoice ? "Escribe la opción personalizada." : "Completa este campo.";
  if (isSingleChoice && !customChoice && field.options?.length && !field.options.some((option) => option.value === text) && !field.custom) {
    return "Selecciona una opción válida.";
  }
  if (field.minLength !== undefined && text.length < field.minLength) return "Escribe al menos " + field.minLength + " caracteres.";
  if (field.maxLength !== undefined && text.length > field.maxLength) return "Escribe como máximo " + field.maxLength + " caracteres.";
  if (field.pattern && text) {
    try {
      if (!new RegExp(field.pattern).test(text)) return "El formato de la respuesta no es válido.";
    } catch {
      return "No se pudo validar el formato de este campo.";
    }
  }
  if (field.format === "email" && text && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return "Introduce un correo electrónico válido.";
  if (field.format === "uri" && text) {
    try {
      const url = new URL(text);
      if (url.protocol !== "https:" && url.protocol !== "http:") return "La dirección debe usar HTTP o HTTPS.";
    } catch {
      return "Introduce una dirección válida.";
    }
  }
  return null;
}

export function OpenCodeQuestionForm({ fields, busy = false, onSubmit }: OpenCodeQuestionFormProps) {
  const signature = useMemo(() => JSON.stringify(fields), [fields]);
  const [values, setValues] = useState<FormValues>(() => initialValues(fields));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [customValues, setCustomValues] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");

  useEffect(() => {
    setValues(initialValues(fields));
    setErrors({});
    setCustomValues({});
    setFormError("");
  }, [signature]); // Reset only when the actual OpenCode form schema changes.

  const visibleFields = fields.filter((field) => isFieldVisible(field, values));
  const answerableFields = visibleFields.filter((field) => field.type.toLowerCase() !== "external");

  function updateValue(key: string, value: unknown) {
    setValues((current) => ({ ...current, [key]: value }));
    setErrors((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    setFormError("");
  }

  function toggleOption(field: OpenCodeFormField, optionValue: string, checked: boolean) {
    const current = asStringArray(values[field.key]);
    const next = checked
      ? [...new Set([...current, optionValue])]
      : current.filter((value) => value !== optionValue);
    updateValue(field.key, next);
  }

  function updateCustomValue(key: string, value: string) {
    setCustomValues((current) => ({ ...current, [key]: value }));
    setErrors((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    setFormError("");
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextErrors: Record<string, string> = {};
    for (const field of answerableFields) {
      const error = validateField(field, values[field.key], customValues[field.key] ?? "");
      if (error) nextErrors[field.key] = error;
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) {
      setFormError("Revisa los campos señalados antes de enviar la respuesta.");
      return;
    }

    const answer: FormValues = {};
    for (const field of answerableFields) {
      const type = field.type.toLowerCase();
      const value = values[field.key];
      if (type === "multiselect" || field.multiple) {
        const selected = asStringArray(value);
        const custom = customValues[field.key]?.trim();
        answer[field.key] = custom && field.custom ? [...selected, custom] : selected;
      } else if (["number", "integer"].includes(type)) {
        if (value === "" || value === undefined || value === null) continue;
        answer[field.key] = typeof value === "number" ? value : Number(value);
      } else if (value === CUSTOM_OPTION && field.custom) {
        answer[field.key] = customValues[field.key]?.trim() ?? "";
      } else {
        answer[field.key] = value;
      }
    }
    onSubmit(answer);
  }

  if (!fields.length) {
    return <div className="opencode-form-empty">OpenCode no proporcionó campos para esta pregunta. Consulta el contexto técnico antes de responder.</div>;
  }

  return (
    <form className="opencode-question-form" onSubmit={submit}>
      <div className="opencode-form-intro">
        <strong>Responde a la solicitud de OpenCode</strong>
        <span>Selecciona las opciones o completa los campos. La respuesta se enviará con el formato que espera el motor.</span>
      </div>
      {visibleFields.map((field) => {
        const type = field.type.toLowerCase();
        const fieldError = errors[field.key];
        const fieldId = "opencode-form-" + field.key.replace(/[^a-zA-Z0-9_-]/g, "-");
        const options = field.options ?? [];
        const selected = asStringArray(values[field.key]);
        const isMulti = type === "multiselect" || field.multiple;
        const isBoolean = ["boolean", "confirm", "checkbox"].includes(type);
        const isNumeric = ["number", "integer"].includes(type);
        const isTextArea = ["textarea", "text-area", "long-text"].includes(type);
        const isSingleChoice = ["select", "radio", "enum"].includes(type) || (type === "string" && options.length > 0 && !isMulti);
        const customSelected = values[field.key] === CUSTOM_OPTION;

        return (
          <fieldset className={"opencode-form-field" + (fieldError ? " has-error" : "")} key={field.key}>
            <legend>{field.title || field.key}{field.required === false ? <span className="opencode-field-optional"> · Opcional</span> : null}</legend>
            {field.description && <p className="opencode-field-description">{field.description}</p>}

            {type === "external" && (
              <div className="opencode-external-field">
                {safeExternalUrl(field.url) ? (
                  <a href={safeExternalUrl(field.url) ?? undefined} target="_blank" rel="noopener noreferrer">
                    {field.title || "Abrir recurso externo"}
                  </a>
                ) : (
                  <span>OpenCode adjuntó un recurso informativo sin una dirección web segura.</span>
                )}
              </div>
            )}

            {isMulti && (
              <div className="opencode-multiselect-options">
                {options.map((option) => {
                  const checked = selected.includes(option.value);
                  return (
                    <label className={"opencode-option-card" + (checked ? " selected" : "")} key={option.value}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={busy}
                        onChange={(event) => toggleOption(field, option.value, event.target.checked)}
                      />
                      <span className="opencode-option-card-copy">
                        <strong>{option.label || option.value}</strong>
                        {option.description && <small>{option.description}</small>}
                      </span>
                      <span className="opencode-option-check">{checked ? "✓" : ""}</span>
                    </label>
                  );
                })}
                {field.custom && (
                  <label className="opencode-custom-option">
                    <span>Otra respuesta</span>
                    <input
                      type="text"
                      value={customValues[field.key] ?? ""}
                      disabled={busy}
                      onChange={(event) => updateCustomValue(field.key, event.target.value)}
                      placeholder="Escribe una opción adicional"
                    />
                  </label>
                )}
                {field.minItems !== undefined || field.maxItems !== undefined ? (
                  <small className="opencode-field-hint">
                    {field.minItems !== undefined ? "Mínimo: " + field.minItems : ""}
                    {field.minItems !== undefined && field.maxItems !== undefined ? " · " : ""}
                    {field.maxItems !== undefined ? "Máximo: " + field.maxItems : ""}
                  </small>
                ) : null}
              </div>
            )}

            {isSingleChoice && (
              <>
                <select
                  id={fieldId}
                  value={typeof values[field.key] === "string" ? values[field.key] as string : ""}
                  disabled={busy}
                  onChange={(event) => updateValue(field.key, event.target.value)}
                >
                  <option value="">Selecciona una opción</option>
                  {options.map((option) => (
                    <option value={option.value} key={option.value}>{option.label || option.value}</option>
                  ))}
                  {field.custom && <option value={CUSTOM_OPTION}>Otra respuesta...</option>}
                </select>
                {field.custom && customSelected && (
                  <input
                    type="text"
                    value={customValues[field.key] ?? ""}
                    disabled={busy}
                    onChange={(event) => updateCustomValue(field.key, event.target.value)}
                    placeholder="Escribe tu opción personalizada"
                  />
                )}
              </>
            )}

            {isBoolean && (
              <label className="opencode-boolean-option">
                <input
                  id={fieldId}
                  type="checkbox"
                  checked={values[field.key] === true}
                  disabled={busy}
                  onChange={(event) => updateValue(field.key, event.target.checked)}
                />
                <span>{field.placeholder || "Sí"}</span>
              </label>
            )}

            {isNumeric && (
              <input
                id={fieldId}
                type="number"
                value={values[field.key] === "" ? "" : String(values[field.key] ?? "")}
                min={field.minimum}
                max={field.maximum}
                step={type === "integer" ? 1 : "any"}
                disabled={busy}
                onChange={(event) => updateValue(field.key, event.target.value)}
                placeholder={field.placeholder || "Introduce un valor"}
              />
            )}

            {!isMulti && !isBoolean && !isNumeric && !isSingleChoice && type !== "external" && (
              isTextArea ? (
                <textarea
                  id={fieldId}
                  value={typeof values[field.key] === "string" ? values[field.key] as string : ""}
                  minLength={field.minLength}
                  maxLength={field.maxLength}
                  required={field.required !== false}
                  disabled={busy}
                  onChange={(event) => updateValue(field.key, event.target.value)}
                  rows={4}
                  placeholder={field.placeholder || "Escribe tu respuesta"}
                />
              ) : (
                <input
                  id={fieldId}
                  type={field.format === "email" ? "email" : field.format === "date" ? "date" : field.format === "date-time" ? "datetime-local" : field.format === "uri" ? "url" : "text"}
                  value={typeof values[field.key] === "string" ? values[field.key] as string : ""}
                  minLength={field.minLength}
                  maxLength={field.maxLength}
                  required={field.required !== false}
                  disabled={busy}
                  onChange={(event) => updateValue(field.key, event.target.value)}
                  placeholder={field.placeholder || "Escribe tu respuesta"}
                />
              )
            )}

            {fieldError && <span className="opencode-field-error">{fieldError}</span>}
          </fieldset>
        );
      })}

      {formError && <div className="opencode-form-error" role="alert">{formError}</div>}
      <div className="opencode-form-actions">
        <span>La respuesta se dirige a la sesión que originó esta solicitud.</span>
        <button className="primary-button" type="submit" disabled={busy || answerableFields.length === 0}>
          {busy ? "Enviando respuesta..." : "Enviar respuesta"} <span>↗</span>
        </button>
      </div>
    </form>
  );
}

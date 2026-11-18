export const EXECUTION_WAVES = [
  { id: "01 · DESCUBRIMIENTO", agentIds: ["architect", "build"] },
  { id: "02 · RECONSTRUCCIÓN", agentIds: ["reverse"] },
  { id: "03 · PROPUESTA", agentIds: ["implementer"] },
  { id: "04 · EJECUCIÓN DE PRUEBAS", agentIds: ["tester"] },
  { id: "05 · REVISIÓN CRUZADA", agentIds: ["reviewer"] },
  { id: "06 · ARBITRAJE FINAL", agentIds: ["cloud-arbiter"] }
] as const;

export type ExecutionWave = (typeof EXECUTION_WAVES)[number];

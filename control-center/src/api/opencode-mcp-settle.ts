/**
 * Ventana de estabilización del catálogo de tools MCP de OpenCode.
 *
 * OpenCode 2.1.4 registra las tools MCP de forma asíncrona: al conectar un
 * servidor publica `mcp.tools.changed` y el registro de tools se recarga tras
 * `Stream.debounce("100 millis")` (packages/core/src/tool/mcp.ts). Conectar el
 * servidor NO implica que el modelo ya vea sus tools.
 *
 * Evidencia real: la sesión `ses_de60a38c3ffeOanuefZYD2GTim` construyó su
 * primer snapshot 97 ms después de `mcp connected`; el registro se actualizó
 * a los ~100 ms y el modelo solo vio la tool `skill`, respondiendo BLOQUEADO.
 *
 * Por eso exigir `status === "connected"` no basta: esta espera adicional
 * exige que el MCP permanezca conectado de forma continua durante una ventana
 * (por defecto 400 ms ≥ 4× el debounce de 100 ms) antes del primer prompt.
 */
export const OPENCODE_MCP_CATALOG_SETTLE_MS = 400;
// 100 ms: reduce la ventana en la que una desconexión/reconexión podría
// quedar entre dos sondeos sin ser observada.
export const OPENCODE_MCP_CATALOG_POLL_MS = 100;

export interface McpCatalogStatus {
  ready: boolean;
  status: string | null;
  error: string | null;
}

export class McpCatalogFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpCatalogFailedError";
  }
}

export interface WaitForMcpCatalogSettledInput {
  observe: () => Promise<McpCatalogStatus>;
  onWaiting?: () => void;
  onSettling?: () => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  settleMs?: number;
  pollMs?: number;
  deadlineMs?: number;
}

export interface McpCatalogSettledResult {
  status: McpCatalogStatus;
  settled: boolean;
  waitedMs: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms));

/**
 * Espera hasta que el MCP observado permanezca `ready` de forma continua
 * durante `settleMs` medidos desde la primera lectura connected. Si el
 * observado deja de estar ready, la ventana se reinicia (fail-closed).
 * Un `status === "failed"` lanza `McpCatalogFailedError` de inmediato.
 * Al agotar `deadlineMs` devuelve `settled: false` con la última observación.
 */
export async function waitForMcpCatalogSettled(
  input: WaitForMcpCatalogSettledInput
): Promise<McpCatalogSettledResult> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? defaultSleep;
  const settleMs = input.settleMs ?? OPENCODE_MCP_CATALOG_SETTLE_MS;
  const pollMs = input.pollMs ?? OPENCODE_MCP_CATALOG_POLL_MS;
  const deadlineMs = input.deadlineMs ?? 15000;

  const start = now();
  let readySince: number | null = null;
  let lastStatus: McpCatalogStatus = { ready: false, status: null, error: null };
  let waitingNotified = false;
  let settlingNotified = false;

  while (now() - start < deadlineMs) {
    const status = await input.observe();
    lastStatus = status;
    if (status.status === "failed") {
      throw new McpCatalogFailedError(status.error ?? "OpenCode devolvió el estado failed sin detalle.");
    }
    if (status.ready) {
      if (!settlingNotified) {
        settlingNotified = true;
        input.onSettling?.();
      }
      if (readySince === null) readySince = now();
      if (now() - readySince >= settleMs) {
        return { status, settled: true, waitedMs: now() - start };
      }
    } else {
      readySince = null;
      if (!waitingNotified) {
        waitingNotified = true;
        input.onWaiting?.();
      }
    }
    await sleep(pollMs);
  }

  return { status: lastStatus, settled: false, waitedMs: now() - start };
}

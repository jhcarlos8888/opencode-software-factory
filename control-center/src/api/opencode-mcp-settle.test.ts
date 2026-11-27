import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  McpCatalogFailedError,
  waitForMcpCatalogSettled,
  type McpCatalogStatus
} from "./opencode-mcp-settle.js";

type ScheduleEntry = { at: number; result: McpCatalogStatus };

const ready = (status = "connected"): McpCatalogStatus => ({ ready: true, status, error: null });
const notReady = (status: string | null = "connecting"): McpCatalogStatus => ({ ready: false, status, error: null });

/**
 * Reloj simulado sin sleeps reales: `sleep` avanza exactamente `pollMs`
 * (emulando el sondeo fijo real, sin saltar al siguiente evento del
 * schedule) y `observe` devuelve la última entrada del schedule cuyo
 * instante sea <= reloj actual.
 */
function makeClock(schedule: ScheduleEntry[], pollMs: number) {
  let clock = 0;
  const observedAt: number[] = [];
  return {
    now: () => clock,
    observedAt,
    observe: async (): Promise<McpCatalogStatus> => {
      observedAt.push(clock);
      let current = schedule[0]?.result ?? notReady();
      for (const entry of schedule) {
        if (entry.at <= clock) current = entry.result;
      }
      return current;
    },
    sleep: async () => {
      clock += pollMs;
    }
  };
}

test("no devuelve el catálogo como asentado durante el registro diferido de OpenCode (97 ms)", async () => {
  // antes de la corrección este caso devolvía el control a los 0 ms: la
  // fábrica solo esperaba `status=connected`, y con el debounce de 100 ms de
  // OpenCode el primer prompt a los 97 ms veía un catálogo incompleto.
  const clock = makeClock(
    [
      { at: 0, result: ready() },
      { at: 97, result: ready() }
    ],
    97
  );
  const result = await waitForMcpCatalogSettled({
    observe: clock.observe,
    sleep: clock.sleep,
    now: clock.now,
    settleMs: 400,
    pollMs: 97,
    deadlineMs: 5000
  });
  assert.ok(result.settled, "debe asentarse antes de agotar el deadline");
  assert.deepEqual(clock.observedAt, [0, 97, 194, 291, 388, 485]);
  assert.ok(result.waitedMs >= 400, "el primer settled ocurre con elapsed >= 400");
  assert.equal(result.waitedMs, 485, "primer settled en t=485 (485 - 0 >= 400)");
});

test("ventana completa: asienta tras observar connected en todas las observaciones (poll 250 ms)", async () => {
  const clock = makeClock(
    [
      { at: 0, result: ready() },
      { at: 250, result: ready() },
      { at: 500, result: ready() }
    ],
    250
  );
  const result = await waitForMcpCatalogSettled({
    observe: clock.observe,
    sleep: clock.sleep,
    now: clock.now,
    settleMs: 400,
    pollMs: 250,
    deadlineMs: 5000
  });
  assert.equal(result.settled, true);
  assert.deepEqual(clock.observedAt, [0, 250, 500]);
  assert.equal(result.waitedMs, 500);
  assert.equal(result.status.ready, true);
});

test("una desconexión reinicia la ventana de estabilización", async () => {
  // notReady 0, ready desde 300; notReady en 600; ready en 700; pollMs=100.
  // La primera ventana (desde t=300) aún no está completa cuando llega la
  // desconexión de t=600; allí la ventana se reinicia, de modo que asienta en
  // t=1100 (1100 - 700 >= 400). Si la ventana NO se reiniciara, habría
  // asentado en t=700 (700 - 300 >= 400), junto con la reconexión.
  const clock = makeClock(
    [
      { at: 0, result: notReady() },
      { at: 300, result: ready() },
      { at: 600, result: notReady("disconnected") },
      { at: 700, result: ready() }
    ],
    100
  );
  const result = await waitForMcpCatalogSettled({
    observe: clock.observe,
    sleep: clock.sleep,
    now: clock.now,
    settleMs: 400,
    pollMs: 100,
    deadlineMs: 5000
  });
  assert.ok(clock.observedAt.includes(600), "la desconexión se observó");
  assert.ok(clock.observedAt.includes(700), "la reconexión se observó sin asentar todavía");
  assert.equal(result.settled, true);
  assert.equal(result.waitedMs, 1100, "asienta tras completar la ventana desde la reconexión, no en 700");
});

test("status failed lanza McpCatalogFailedError con el detalle del servidor", async () => {
  const clock = makeClock(
    [{ at: 0, result: { ready: false, status: "failed", error: "MODULE_NOT_FOUND: factory-filesystem.mjs" } }],
    250
  );
  await assert.rejects(
    waitForMcpCatalogSettled({
      observe: clock.observe,
      sleep: clock.sleep,
      now: clock.now,
      settleMs: 400,
      pollMs: 250,
      deadlineMs: 5000
    }),
    (error: unknown) => {
      assert.ok(error instanceof McpCatalogFailedError);
      assert.equal(error.name, "McpCatalogFailedError");
      assert.match(error.message, /MODULE_NOT_FOUND: factory-filesystem\.mjs/);
      return true;
    }
  );
});

test("deadline agotado devuelve settled:false con la última observación", async () => {
  const clock = makeClock([{ at: 0, result: notReady("connecting") }], 250);
  const result = await waitForMcpCatalogSettled({
    observe: clock.observe,
    sleep: clock.sleep,
    now: clock.now,
    settleMs: 400,
    pollMs: 250,
    deadlineMs: 600
  });
  assert.equal(result.settled, false);
  assert.deepEqual(clock.observedAt, [0, 250, 500]);
  assert.equal(result.status.ready, false);
  assert.equal(result.status.status, "connecting");
  assert.equal(result.waitedMs, 750, "sale del bucle tras el sondeo que cruza el deadline");
});

test("onWaiting y onSettling se invocan exactamente una vez", async () => {
  const clock = makeClock(
    [
      { at: 0, result: notReady() },
      { at: 100, result: ready() }
    ],
    100
  );
  let waitingCalls = 0;
  let settlingCalls = 0;
  const result = await waitForMcpCatalogSettled({
    observe: clock.observe,
    sleep: clock.sleep,
    now: clock.now,
    onWaiting: () => { waitingCalls += 1; },
    onSettling: () => { settlingCalls += 1; },
    settleMs: 400,
    pollMs: 100,
    deadlineMs: 5000
  });
  assert.equal(result.settled, true);
  assert.equal(waitingCalls, 1);
  assert.equal(settlingCalls, 1);
});

test("contrato: execution.ts delega la estabilización y ya no retorna al primer connected", async () => {
  const source = await readFile(join(dirname(fileURLToPath(import.meta.url)), "execution.ts"), "utf8");
  assert.ok(source.includes("waitForMcpCatalogSettled("), "execution.ts debe usar la espera de estabilización");
  assert.ok(source.includes("if (!settle.settled)"), "execution.ts debe fallar cerrado si no se asienta");
  assert.ok(
    !source.includes("if (lastStatus.ready) {"),
    "el retorno inmediato al primer connected (bloque if (lastStatus.ready)) debe estar eliminado"
  );
  assert.ok(
    source.includes("OPENCODE_MCP_CATALOG_SETTLE_MS"),
    "el mensaje de fallo debe interpolar la constante de estabilización, no un 400 hardcodeado"
  );
  assert.ok(
    !source.includes("estabilización del catálogo (400 ms)"),
    "el 400 hardcodeado del mensaje de fallo debe estar eliminado"
  );
  assert.ok(
    source.includes("settle.status.status ?? \"no registrado\""),
    "el estado del fallo debe venir solo de settle.status, sin mezclar lastStatus"
  );
  assert.ok(
    !source.includes("settle.status.status ?? lastStatus.status"),
    "no se debe mezclar settle.status.status con lastStatus.status en el mensaje de fallo"
  );
  assert.ok(
    source.includes("MCP factory_filesystem conectado y catálogo estabilizado en "),
    "el mensaje de éxito debe reflejar la ventana de estabilización"
  );
  assert.ok(
    !source.includes("MCP factory_filesystem conectado al proyecto seleccionado"),
    "el antiguo mensaje de éxito del retorno inmediato debe estar eliminado"
  );
});

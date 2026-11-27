# MCP filesystem: causa raíz (codemode, entorno y override)

Documento propio de este repositorio. Explica por qué el servidor MCP
`factory_filesystem` dejó de arrancar de forma fiable y qué contrato lo
impide volver a romper. La evidencia procede del historial git del propio
repositorio y de las pruebas que viven en `scripts/`.

## Síntomas observados

- El servidor MCP no respondía (o no exponía sus herramientas) cuando se
  arrancaba fuera del runtime de la fábrica.
- El launcher dependía de una variable de entorno que solo existe dentro del
  proceso que arranca la fábrica.
- El valor `codemode` del bloque MCP no coincidía con el modo en el que
  trabaja la fábrica.

## Causa raíz 1 — `codemode: false` frente a Code Mode

- El bloque se introdujo con `codemode: false` en el commit `8e1f7d1`
  (*harden factory orchestration and agent governance*, 2026-11-17).
- La fábrica opera en **Code Mode**: el contrato canónico del registro exige
  `codemode: true` para que el servidor se exponga en el modo en el que se
  consumen sus herramientas.
- Estado actual: `opencode.json` declara `"codemode": true`, y dos
  verificadores impiden la regresión:
  - `scripts/verify-opencode-agents.py` → `filesystem_mcp_contract_error()`
    falla con `codemode=false` o ausente (`factory_filesystem debe declarar
    codemode=true (codemode=false no está permitido)`).
  - `scripts/factory-filesystem.test.mjs` afirma `codemode === true` y
    `notEqual(codemode, false)`.

### Nota sobre `enabled` (compatibilidad, sin cambio de configuración)

`mcp.servers.factory_filesystem.enabled: true` es preexistente y se conserva
por compatibilidad: **OpenCode V2 ignora este campo** y un `enabled` ausente
mantiene el servidor habilitado. No se modifica ninguna configuración por
este motivo; el verificador sigue exigiendo `enabled=true` solo para detectar
una regresión explícita en el contrato de la fábrica.

## Causa raíz 2 — el entrypoint `{env:…}` no existe en un shell normal

- Tras el commit `e4bd4fb` (*align MCP launcher diagnostics and registry
  contract*) el comando era `["node", "{env:FACTORY_FILESYSTEM_MCP_ENTRYPOINT}"]`
  con un bloque `environment` que repetía la misma referencia.
- Esa variable solo la define el runtime de la fábrica al arrancar OpenCode
  (`execution.ts`, añadido en `8e1f7d1`:
  `FACTORY_FILESYSTEM_MCP_ENTRYPOINT: <fábrica>/.opencode/mcp/factory-filesystem.mjs`).
- En un shell normal (una sesión `opencode` manual, un proceso arrancado por
  otro lanzador, un proceso de CI) la variable **no existe**, `{env:…}` no se
  resuelve y el servidor no arranca.
- Solución: **bootstrap estático en el comando** (`node -e <código fijo>`):
  1. Si `FACTORY_FILESYSTEM_MCP_ENTRYPOINT` tiene valor (lo inyecta Control
     Center con la **ruta absoluta** del launcher de la fábrica), el bootstrap
     normaliza esa variable y ejecuta
     `import(pathToFileURL(resolve(valor)).href)`: es el mecanismo baseline
     para proyectos externos.
  2. Si la variable no existe, resuelve
     `.opencode/mcp/factory-filesystem.mjs` contra el cwd
     (`pathToFileURL(resolve(...))`) y lo importa: **fallback directo desde la
     fábrica** (cuando el cwd es la fábrica).
  3. Si la ruta no existe, el bootstrap escribe `[factory-filesystem] …` por
     stderr y sale con código 1: **sin fallback silencioso** que cambie la
     intención. El módulo sigue detectando su arranque con la variable
     normalizada o con `argv[1]`.
  El código es fijo y corre en `node -e`: sin shell, sin prompt y sin
  `child_process`. Se conservan `environment`, `codemode=true` y
  `enabled=true`, no se copia ningún launcher al proyecto y **el cwd del MCP
  no se fija**: sigue siendo el proyecto para que los guards (raíz canónica,
  traversal, symlinks, secretos) se apliquen.

## Causa raíz 3 — el override completo del comando del servidor se retiró

- El bootstrap original era un override frágil y dependiente del entorno:
  `node -e "import(require('node:url').pathToFileURL(require('node:path').resolve(process.env.FACTORY_FILESYSTEM_MCP_ENTRYPOINT || '.opencode/mcp/factory-filesystem.mjs')).href)"`.
- `e4bd4fb` lo sustituyó por `{env:…}` (siguiendo dependiendo del entorno) y
  `c5a3a31` (*resolve factory MCP entrypoint through runtime symlinks*) tuvo
  que arreglar además la resolución de symlinks del runtime.
- El cambio actual **retira ese override por variables**: el comando vuelve a
  ser un bootstrap fijo versionado que resuelve el entrypoint inyectado o el
  relativo de fábrica y falla de forma visible si no existe. No hay
  configuración derivada por run ni override por proyecto:
  `OPENCODE_CONFIG` y `OPENCODE_CONFIG_DIR` siguen apuntando a la fábrica
  (`8e1f7d1`).

## Causa raíz 4 — registro asíncrono de tools MCP (debounce de 100 ms)

- **Síntoma:** una sesión arrancó con el MCP `factory_filesystem` en estado
  `connected`, pero el modelo respondió BLOQUEADO porque solo veía la tool
  `skill`: las tools del MCP no estaban expuestas todavía.
- **Evidencia:** la sesión real `ses_de60a38c3ffeOanuefZYD2GTim` registró
  `mcp connected` a las 22:24:27.409Z y el primer mensaje del assistant a las
  22:24:27.506Z (delta 97 ms) con `tools=4`; el modelo solo vio `skill`. El
  registro de tools se actualizó a los ~100 ms, después del primer prompt.
- **Mecanismo:** OpenCode 2.1.4 registra las tools MCP de forma asíncrona. Al
  conectar un servidor publica `mcp.tools.changed` y el registro se recarga
  tras `Stream.debounce("100 millis")` (`packages/core/src/tool/mcp.ts`).
  Conectar el servidor **no implica** que el modelo ya vea sus tools: exigir
  solo `status === "connected"` en `waitForFactoryFilesystemMcp` dejaba pasar
  el primer prompt dentro de esa ventana de ~100 ms.
- **Corrección:** `control-center/src/api/opencode-mcp-settle.ts` añade
  `waitForMcpCatalogSettled`, que exige que el MCP esté `connected` en
  **todas** las observaciones durante una ventana de estabilización de
  **400 ms** (`OPENCODE_MCP_CATALOG_SETTLE_MS`, ≥ 4× el debounce de 100 ms)
  medida desde la primera lectura connected. El sondeo es cada 100 ms
  (`OPENCODE_MCP_CATALOG_POLL_MS`): no hay stream de eventos de estado, de
  modo que la única forma de comprobar la ventana es observando
  periódicamente. Incluye reinicio de la ventana si la conexión se pierde,
  error inmediato ante `status: "failed"` (`McpCatalogFailedError`) y fallo
  cerrado al agotar el deadline de 15 s. La política source-only, la detección
  de MCP externos y el resto del flujo no cambian (`execution.ts`,
  `waitForFactoryFilesystemMcp`).
- **Límite:** esta ventana de estabilización no sustituye la prueba real con
  modelo: solo elimina la condición de carrera documentada. La verificación
  end-to-end con un modelo real sigue siendo necesaria para afirmar que el
  catálogo es visible en el primer prompt.

### Verificación real (26 nov 2026)

Sesión final `ses_de5c90eb4ffeEI07Zovzd4FnEh` (agente `reverse`, modelo
`opencode-go/glm-5.3-flash`, build desplegado
`sha256:8fb3e4e059e87ff65af732866f5fdbcbe60674a8f8048d1046294d8b122f003e`):
el gate de estabilización devolvió `settled=true` con `waitedMs=1260` y el
agente hizo **una única invocación** de `factory_filesystem_read_file` sobre
`src/documents.js` con `state.status=completed`; el resultado incluye
`export function getDocument(...)` y el texto final cita la línea 1 del
fichero. No hay `execute`, `skill`, shell ni escritura. Consumo: turno 1
`input 3147 / output 31 / reasoning 37`; turno 2 `input 351 / output 37 /
reasoning 84` (cache read 3136); coste total `0.00050605 + 0.00020723`. La
evidencia persistente (README, `evidence.json` y `server.log`) está en
`~/.local/state/opencode-software-factory/source-only-real-test-20261126-final/`.

La primera prueba real, sobre el build anterior, usó la sesión
`ses_de5d6f1d9ffevwi1PrGdsAYm32` con `waitedMs=505`; por eso esta sección cita
la segunda prueba como evidencia del build desplegado. La evidencia de los
97 ms sigue siendo la de la sesión `ses_de60a38c3ffeOanuefZYD2GTim`
(log + BD), no la de estas sesiones.

## Qué comprueban las pruebas (lista, lectura, búsqueda y rechazo)

`scripts/factory-filesystem.test.mjs`:

- `list_files` omite symlinks, ficheros sensibles, metadatos de Git y
  `node_modules`.
- `read_file` solo abre ficheros no sensibles dentro de la raíz canónica y
  rechaza `.env`, `.git/config`, traversal (`../`), rutas absolutas,
  symlinks y ficheros ausentes.
- `search_text` hace búsqueda literal confinada al proyecto y rechaza
  búsquedas fuera de alcance, consultas vacías y ficheros binarios o grandes.
- **Test A (sin env, cwd fábrica)**: el bootstrap arranca sin
  `FACTORY_FILESYSTEM_MCP_ENTRYPOINT` con cwd en la fábrica y responde a
  `initialize` y `tools/list` con las cuatro herramientas.
- **Test B (env absoluto, proyecto externo sin `.opencode`)**: con la ruta
  absoluta del launcher inyectada y cwd en
  `control-center/src/api/test-fixtures/external-mcp-project/`, lista las
  cuatro herramientas, **lee** `public-fixture.txt` del proyecto externo y
  **rechaza** `../fuera.txt` (la raíz del MCP sigue siendo el proyecto
  externo); además comprueba que no se copia ningún launcher al fixture.
- **Test C (entrypoint inexistente)**: con la variable apuntando a una ruta
  inexistente el proceso termina con código distinto de cero, escribe
  `[factory-filesystem] …` por stderr y **no** responde `tools/list` (sin
  fallback silencioso).
- Rechazo visible por el protocolo stdio: `read_file` sobre `.env` devuelve
  `isError: true` y no entrega el contenido.
- Anti-regresión: el bootstrap no contiene `{env:` y `codemode` no puede ser
  `false`.

`scripts/verify-opencode-agents.py` (+ `verify-opencode-agents.test.py`):

- Contrato canónico: bootstrap `[node, -e, <código>]` con las marcas
  obligatorias (`require("node:path")`, `require("node:url")`,
  `pathToFileURL`, `FACTORY_FILESYSTEM_MCP_ENTRYPOINT`,
  `.opencode/mcp/factory-filesystem.mjs`, `import(`), sin marcas prohibidas
  (backticks, `child_process`, `eval(`, `Function(`, `require("fs")`, `curl`,
  `wget`), más `codemode=true`, `enabled=true` y el guard de entorno; el
  `opencode.json` real del repositorio debe cumplirlo.
- Rechazo explícito de launcher directo, launcher env-only, bootstrap sin
  resolución del entrypoint, bootstrap con código prohibido, `codemode=false`,
  `codemode` ausente, servidor no local y guard de entorno eliminado.

## Regresiones cubiertas

| Regresión | Cubierta por |
| --- | --- |
| Volver a `{env:…}` como comando | `verify-opencode-agents.test.py` (`test_env_only_launcher_is_rejected`) |
| Volver al launcher directo sin bootstrap | `verify-opencode-agents.test.py` (`test_direct_relative_launcher_is_rejected`) y tests A/B |
| `codemode: false` | Ambos verificadores (aserción y test python) |
| Servidor no local / ausente | `filesystem_mcp_contract_error()` |
| Symlinks en config, carpetas o agentes | `verify-opencode-agents.test.py` (`SymlinkBoundaryTests`) |
| Ficheros sensibles o traversal por el MCP | `factory-filesystem.test.mjs` (read/list/search) |
| Proyecto externo sin `.opencode` | Test B (env absoluto + raíz del MCP en el proyecto) |
| Fallback silencioso ante entrypoint inexistente | Test C |
| Nomenclatura obsoleta de herramientas en agentes | `verify-opencode-agents.test.py` (`AgentToolNomenclatureTests`) |

## Cómo verificar

```sh
node --test scripts/factory-filesystem.test.mjs
python3 scripts/verify-opencode-agents.test.py
python3 scripts/verify-opencode-agents.py
bash scripts/verify-factory.sh
```

## Límites

- Las pruebas A/B/C arrancan el servidor MCP con `node` local; no ejecutan
  ningún modelo ni proveedor de pago.
- El guard de entorno se mantiene: el bootstrap lo normaliza a ruta absoluta
  cuando Control Center lo inyecta; sin él se usa el fallback relativo (cwd de
  la fábrica).
- **No se afirma una ejecución end-to-end con motores ni de la interfaz web
  hasta que el Tester la ejecute y registre su evidencia.**

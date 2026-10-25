
# OpenCode Software Factory

Repositorio fuente de la fábrica de software multiagente.

## Objetivos

- Coordinar análisis, planificación, implementación y revisión.
- Mantener agentes, skills y comandos versionados.
- Exigir evidencia real de compilaciones y pruebas.
- Separar la infraestructura de la fábrica de los proyectos de trabajo.
- Permitir instalación y reversión controladas.

## Estructura

- `.opencode/agents/`: agentes Markdown existentes.
- `.opencode/commands/`: comandos personalizados existentes.
- `.opencode/skills/`: skills del directorio global de OpenCode.
- `.agents/skills/`: skills del directorio compatible con agentes.
- `config/global-inline-agents.snapshot.json`: instantánea de los agentes
  `build` y `reverse` definidos actualmente en la configuración global.
- `opencode.json`: configuración predeterminada de este repositorio.
- `templates/AGENTS.md`: plantilla de instrucciones que la fábrica instala en
  los proyectos consumidores.

## Estado de migración

El flujo real es un instalador reversible controlado por Git:

- `python3 scripts/factory.py install <proyecto>`: instala agentes, skills,
  comandos, `opencode.json` y (solo si falta) `AGENTS.md` en el proyecto
  consumidor.
- `python3 scripts/factory.py status <proyecto>`: revisa los archivos instalados.
- `python3 scripts/factory.py uninstall <proyecto>`: retira únicamente los
  archivos sin modificar.
- `python3 scripts/factory.py doctor <proyecto>`: comprueba que la fábrica
  funciona realmente en el proyecto consumidor usando el CLI de OpenCode
  (`opencode debug agents` y `opencode debug config`): los 6 agentes
  reconocidos con su modo, proveedor y modelo correctos, y la carga del
  `opencode.json` del proyecto con `default_agent: build` y el modelo esperado.
  Devuelve 0 si todo PASS, 2 si hay hallazgos y 1 si hay un error técnico.
- `python3 scripts/factory.py self-test`: prueba el instalador en directorios
  temporales aislados.

### Modelo fijado

La fábrica fija `opencode-go/mimo-v2.6-flash` en `opencode.json` y en el
frontmatter de los seis agentes de `.opencode/agents/`.

### Migración de la configuración

- `provider` → `providers` (la clave `provider` está deprecada según el
  esquema oficial de OpenCode).
- `compaction.prune` → `compaction.keep.tokens: 15000` (`prune` está deprecado).
- La configuración actual **no** usa `providers`: el modelo es el integrado de
  OpenCode. El bloque `providers` solo hace falta al volver a OpenRouter
  (ver más abajo).

### Instalación de `opencode.json` con protección `CONFLICTO`

- Si el proyecto no tiene `opencode.json`, se crea con el contenido de la
  fábrica y se registra en el manifiesto.
- Si el `opencode.json` del proyecto es idéntico al de la fábrica, se omite
  (`skipped`) y se conserva.
- Si el `opencode.json` del proyecto es distinto, el instalador entra en
  estado `CONFLICTO` y devuelve el código 2 sin instalar nada: el archivo del
  proyecto jamás se sobrescribe.

### Instalación de `AGENTS.md` (plantilla opcional)

- Si el proyecto **no** tiene `AGENTS.md`, se crea con la plantilla
  `templates/AGENTS.md` y se registra en el manifiesto.
- Si el proyecto **ya** tiene `AGENTS.md` (archivo, enlace o lo que sea), se
  conserva intacto: no es un conflicto, no aborta la instalación y no se
  registra en el manifiesto. Nunca se sobrescribe.
- `uninstall` retira el `AGENTS.md` creado por la fábrica solo si nadie lo
  modificó; si el usuario lo editó, se conserva.

Los agentes `build` y `reverse` siguen activos en la configuración global.
La instantánea se conserva para migrarlos de forma controlada más adelante.
No modificar ni instalar automáticamente esa instantánea.

La configuración global, los MCP y las credenciales existentes no se
modifican mediante esta captura.

## Modelo de referencia

`opencode-go/mimo-v2.6-flash` (MiMo V2.6 Flash, servido por el proveedor
integrado OpenCode Go). Es el modelo fijado en `opencode.json` y en los seis
agentes, sin bloque `providers`: el formato `opencode-go/<model-id>` en la
clave `model` basta porque OpenCode ya integra el proveedor.

Requisitos:

- Plan OpenCode Go activo, con un límite de uso de aproximadamente **60 $/mes**
  propio del plan Go.
- Conexión del workspace mediante `/connect` → **OpenCode Go** (autenticación
  con la cuenta de OpenCode).

## Cómo volver a OpenRouter (cuando haya crédito)

Cuando el workspace vuelva a tener crédito, se puede restaurar el modelo
anterior con este bloque en `opencode.json`:

```json
{
  "model": "openrouter/xiaomi/mimo-v2.6-flash",
  "default_agent": "build",
  "providers": {
    "openrouter": {
      "models": {
        "xiaomi/mimo-v2.6-flash": {
          "limit": { "context": 87378, "output": 3500 }
        }
      },
      "options": { "max_tokens": 3500 }
    }
  }
}
```

Advertencia: sin `limit.output` ni `options.max_tokens`, OpenCode solicita el
valor por defecto de **131072** tokens de salida, que es exactamente lo que
provoca el error de créditos anterior. Además hay que volver a fijar
`openrouter/xiaomi/mimo-v2.6-flash` en el frontmatter `model:` de los seis
agentes de `.opencode/agents/` (hoy fijan `opencode-go/mimo-v2.6-flash`).

## Principios de calidad

- No afirmar que una prueba pasó si no se ejecutó y se observó su salida.
- No inventar archivos, herramientas, resultados ni fuentes.
- Revisar los cambios mediante Git.
- Proteger operaciones destructivas y despliegues mediante aprobación.
- Separar hallazgos comprobados de hipótesis.

## Mejoras de fiabilidad y validación

### Arquitecto: planes respaldados por evidencia

El agente `architect` debe inspeccionar las instrucciones, los manifiestos,
el código y las pruebas pertinentes antes de proponer un plan. Debe distinguir
hechos verificados, inferencias y datos desconocidos; diferenciar versiones
declaradas de versiones resueltas; y no inventar rutas, dependencias,
comandos ni resultados. Su función es planificar, no modificar el repositorio.

Archivo: `.opencode/agents/architect.md`.

### Descubrimiento de proyectos

La skill `project-discovery` exige que las conclusiones sobre estructura,
stack, dependencias, pruebas y comandos se apoyen en archivos leídos o
comprobaciones ejecutadas. También exige revisar el estado de Git y respetar
los cambios preexistentes.

Archivo: `.opencode/skills/project-discovery/SKILL.md`.

### Tester: resultados reales y permisos

El agente `tester` debe informar los comandos ejecutados, sus códigos de
salida, los resultados observados y las pruebas que no se ejecutaron.
Debe diferenciar la verificación estructural de la ejecución real de las
pruebas del proyecto. La edición de archivos permanece denegada.

Permisos de shell actuales del `tester`:

- **Sin aprobación** (`effect: allow`): lectura de Git (`git status`, `git
  diff`, `git log`, `git show`), `bash scripts/verify-factory.sh`,
  `python3 scripts/factory.py self-test|status|doctor`, y los builds y tests
  habituales: Gradle (`./gradlew test|build|clean test`, `gradle test`),
  Maven (`mvn test|verify`, `mvn -B test|verify`), Python
  (`python3 -m pytest`, `pytest`, `python3 -m unittest`,
  `python3 -m compileall`, `ruff check`), Node/TS (`npm test`,
  `npm run test`, `npm ci`, `npm install`, `npx tsc`, `tsc`, `eslint`,
  `node --test`) y `make test|build`.
- **Denegados explícitamente** (`effect: deny`, y por tanto prevalecen):
  `sudo`, `rm`, `rm -rf`, `git push`, `git commit`, `git checkout`,
  `git reset`, `git restore`, `curl`, `wget`, y toda edición de archivos.
- **Todo lo demás** sigue pidiendo aprobación (`shell * -> ask`).

Archivo: `.opencode/agents/tester.md`.

### Modelo y verificación de la fábrica

La configuración del repositorio y el script `scripts/verify-factory.sh`
usan `opencode-go/mimo-v2.6-flash` como modelo configurado.

El script `bash scripts/verify-factory.sh` valida la configuración JSON, el
modelo fijado en los seis agentes, el newline final de los archivos
instalables, la plantilla `templates/AGENTS.md`, la estructura de agentes y
skills, la carga de la configuración de OpenCode, el reconocimiento de los
agentes y, al final, el self-test del instalador. Esta comprobación es
estructural: no sustituye las pruebas del proyecto consumidor ni demuestra
por sí sola que las respuestas de los agentes sean correctas.

### Validaciones registradas

Ejecutadas el 24 de octubre de 2026 en este repositorio, con sus códigos de
salida reales:

- `jq -e . opencode.json` → código 0 (JSON válido).
- `python3 -m py_compile scripts/factory.py` → código 0 (sin errores).
- `python3 scripts/factory.py self-test` → código 0, salida
  `SELF-TEST COMPLETADO`. Incluye los cuatro casos: instalación con
  `AGENTS.md` ausente (se crea y la desinstalación lo retira),
  `AGENTS.md` preexistente (se conserva intacto, no es conflicto),
  `opencode.json` idéntico y conflictos que abortan sin sobrescribir.
- `python3 scripts/factory.py doctor <proyecto recién instalado>` → código 0
  con 27 líneas `PASS` y 0 `ERROR`. Se observó que la primera invocación de
  `opencode debug agents` en un directorio nuevo devuelve `[]`; `doctor`
  lo detecta, lo informa y reintenta una vez.
- `python3 scripts/factory.py doctor <directorio sin opencode.json>` →
  código 1 con mensaje explicativo.
- `bash scripts/verify-factory.sh` → código 0, todos los pasos en `PASS`.
- Estas validaciones no equivalen a ejecutar las pruebas de un proyecto Java
  ni a verificar la calidad de todas las respuestas generadas por los agentes.

### Validación del cambio a OpenCode Go (25 de octubre de 2026)

Cambio de modelo de `nvidia/nemotron-3-ultra-550b-a55b` a
`opencode-go/mimo-v2.6-flash`, ejecutado con estos códigos de salida reales:

- `jq -e . opencode.json` y `jq -e ~/.config/opencode/opencode.json` → código 0.
- `grep -l '^model: opencode-go/mimo-v2.6-flash' .opencode/agents/*.md | wc -l`
  → `6`.
- `grep -rn 'nemotron-3-ultra-550b-a55b'` sobre JSON/MD/SH/PY del repositorio →
  0 coincidencias.
- `python3 -m py_compile scripts/factory.py` → código 0.
- `python3 scripts/factory.py self-test` → código 0, `SELF-TEST COMPLETADO`.
- `bash scripts/verify-factory.sh` → código 0, todos los pasos en `PASS`.
- `opencode debug config` → para `opencode.json` del repositorio:
  `providerID: opencode-go`, `model: mimo-v2.6-flash`, `default_agent: build`.
- `opencode debug agents` → los seis agentes con `opencode-go/mimo-v2.6-flash`
  y sus modos esperados.
- `opencode run --model opencode-go/mimo-v2.6-flash "Responde únicamente: OK"`
  → respuesta `OK`, código 0 (llamada real al modelo).
- Config global: respaldo `~/.config/opencode/opencode.json.bak-20261025`;
  la comparación con `del(.model)` da código 0, es decir, solo cambia el campo
  `model` (`mistral/codestral-2508` → `opencode-go/mimo-v2.6-flash`).
- Corrección aplicada en la revisión: el grep del paso 1b quedó anclado a la
  línea completa (`grep -qx`), de modo que un modelo con sufijo (por ejemplo
  `mimo-v2.6-flash-free`) ya no aprueba el check. Comprobado con un fichero
  falso: sufijo `-free` → código 1, modelo exacto → código 0.

### Separación entre fábrica y proyectos consumidores

La fuente mantenible de los agentes, skills, comandos, scripts y documentación
debe permanecer en este repositorio: `opencode-software-factory`.
Los proyectos consumidores son destinos de instalación y prueba, no el lugar
donde se deben desarrollar o documentar las mejoras generales de la fábrica.

Antes de instalar o sincronizar cambios en un consumidor, se debe revisar
el estado del destino y preservar sus archivos propios, su configuración
`opencode.json` y cualquier modificación ajena. No se deben eliminar archivos
sin verificar su procedencia y obtener autorización cuando exista duda.

### Nuevas skills

Se han añadido las siguientes skills en `.opencode/skills/`:

- **metric-collector**: Recopila métricas de ejecución (tiempo de build, cobertura, número de archivos, etc.).
- **dependency-audit**: Audita dependencias en busca de vulnerabilidades (CVE), licencias incompatibles y versiones desactualizadas. Soporta Maven, Gradle, npm, pnpm, yarn, pip-audit, safety, cargo audit, govulncheck.
- **security-scan**: Escaneo de seguridad estático (SAST) y detección de secretos. Soporta SpotBugs, SonarQube, ESLint security, CodeQL, Bandit, Semgrep, gosec, cargo clippy, truffleHog, git-secrets, detect-secrets.

Todas las skills están incluidas en la validación de `scripts/verify-factory.sh`.

### Proyectos de prueba incluidos

Este repositorio ahora contiene proyectos de ejemplo para validar la instalación
de la fábrica en distintos stacks:

- `springboot-gradle/` – proyecto Java mínimo con Gradle (`build.gradle`).
- `springboot-maven/` – proyecto Java mínimo con Maven (`pom.xml`).
- `typescript/` – proyecto TypeScript con `package.json` y `tsconfig.json`.
- `python/` – proyecto Python con `pyproject.toml` y tests con `pytest`.

Estos proyectos pueden usarse como destino del instalador:
`python3 scripts/factory.py install <ruta-proyecto>` y luego
`python3 scripts/factory.py doctor <ruta-proyecto>`.

### Pendientes

- Probar el cumplimiento de las nuevas reglas del arquitecto con resultados
  contrastados contra los archivos reales del proyecto de prueba.
- Verificar que el tester informe correctamente los códigos de salida y
  distinga las pruebas reales de las verificaciones estructurales.
- Revisar cualquier configuración sobrante del proyecto consumidor por
  separado, sin usarlo como repositorio fuente de las mejoras.

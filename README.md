
# OpenCode Software Factory

Repositorio fuente de la fábrica de software multiagente.

## Objetivos

- Coordinar análisis, planificación, implementación y revisión.
- Mantener agentes, skills y comandos versionados.
- Exigir evidencia real de compilaciones y pruebas.
- Separar la infraestructura de la fábrica de los proyectos de trabajo.
- Permitir instalación y reversión controladas.

## Estructura

- `.opencode/agents/`: 6 agentes Markdown (`build`, `architect`,
  `implementer`, `reviewer`, `tester`, `cloud-arbiter`).
- `.opencode/commands/`: 5 comandos (`/planificar`, `/implementar`,
  `/revisar`, `/verificar`, `/calidad-java`).
- `.opencode/skills/`: 10 skills del directorio global de OpenCode.
- `.agents/skills/`: 1 skill de terceros (`reverse-engineer-anything`).
- `config/global-inline-agents.snapshot.json`: instantánea de los agentes
  `build` y `reverse` definidos actualmente en la configuración global.
- `opencode.json`: configuración predeterminada de este repositorio.
- `templates/AGENTS.md`: plantilla de instrucciones que la fábrica instala en
  los proyectos consumidores.

## Guía de uso

Guía completa para instalar la fábrica en un proyecto y usarla desde OpenCode.
Todos los códigos de salida de esta sección se ejecutaron el **25 de octubre
de 2026** en esta máquina y se observaron su salida. Lo que no se ejecutó
aparece marcado explícitamente como *no ejecutado*.

### Requisitos previos

| Requisito | Versión observada | Comprobación |
| --- | --- | --- |
| Python 3 | 3.14.4 | `python3 --version` → 0 |
| CLI de OpenCode v2 | v2.0.31 | `opencode --version` → 0 |
| git | 2.53.0 | `git --version` → 0 |
| Plan OpenCode Go | conectado con `/connect` → **OpenCode Go** | comprobación interactiva en la CLI |
| JDK (para la batería Java) | `java -version` → OpenJDK 17.0.20 (Temurin 17.0.20+8); en la máquina hay además instalados `21.0.12+1.1-tem` y `25.0.4-tem` | `java -version` → 0 |
| Maven / Gradle | 3.9.16 / 8.14.5 | `mvn -version`, `gradle --version` → 0 |
| Docker | **no instalado** | `docker --version` → 127 (command not found) |

- El instalador (`scripts/factory.py`) usa solo la librería estándar de
  Python: no hay dependencias que instalar con `pip`.
- **Stacks soportados**: el instalador es agnóstico del stack (copia agentes,
  comandos y skills sin interpretar el proyecto). Los permisos de verificación
  sin aprobación cubren Java (Maven/Gradle), Python (pytest, unittest, ruff),
  Node/TypeScript (npm, tsc, eslint) y `make`. El repositorio incluye proyectos
  de prueba de cuatro stacks: `springboot-gradle/`, `springboot-maven/`,
  `typescript/` y `python/`.
- Sin plan de modelo conectado la instalación funciona, pero los agentes no
  podrán responder: conecta con `/connect` → **OpenCode Go** antes de delegar.
- Docker ausente implica que Testcontainers y cualquier prueba que necesite
  contenedores **no puede ejecutarse en esta máquina** (marcar como no
  ejecutable, nunca como pasada).

### Instalación paso a paso

```bash
# 1. Vista previa: no modifica nada (muestra lo que se copiaría)
python3 scripts/factory.py install --dry-run <ruta-del-proyecto>

# 2. Instalación real
python3 scripts/factory.py install <ruta-del-proyecto>

# 3. Comprobación de archivos y de comportamiento real
python3 scripts/factory.py status  <ruta-del-proyecto>
python3 scripts/factory.py doctor  <ruta-del-proyecto>

# 4. Reversión: retira únicamente los archivos sin modificar
python3 scripts/factory.py uninstall <ruta-del-proyecto>
```

Salida real de `install` en un directorio nuevo (25/10/2026, código 0):

```text
Destino: /tmp/opencode/factory-guide-demo
Archivos nuevos: 31
Archivos idénticos o preexistentes que se conservarán: 0
  + .opencode/agents/architect.md
  ... (6 agentes, 5 comandos, 10 skills) ...
  + .agents/skills/reverse-engineer-anything/SKILL.md
  + opencode.json
  + AGENTS.md

Instalación completada.
Manifiesto de control: /home/jcherre/.local/state/opencode-software-factory/3db2ee952bf55d2bb40df918.json
opencode.json solo se crea si falta o si coincide con el de la
fábrica; nunca se sobrescribe. AGENTS.md solo se crea si falta
y nunca se sobrescribe.
```

Los 31 archivos se descomponen en: 6 agentes + 5 comandos + 10 skills de la
fábrica (un `SKILL.md` por skill) + 8 ficheros de la skill de terceros
`reverse-engineer-anything` + `opencode.json` + `AGENTS.md`.

Salida real de `status` justo después de instalar: 31 líneas `SIN CAMBIOS`
→ código 0.

Salida real de `doctor` **inmediatamente** después de `install` (código 0,
27 `PASS`, 0 `ERROR`):

```text
NOTA: 'opencode debug agents' aún no muestra los agentes del proyecto (intento 1/5); se reintenta en 2 s.
PASS: agente 'architect' reconocido
...
PASS: modelo mimo-v2.6-flash en /tmp/.../opencode.json (obtenido: mimo-v2.6-flash)

Doctor: la fábrica funciona en este proyecto.
```

#### Códigos de retorno

| Comando | `0` | `1` | `2` |
| --- | --- | --- | --- |
| `install` | instalación completada (o `--dry-run` sin tocar nada) | error técnico: destino inválido, ruta insegura, fuente ausente o manifiesto ya existente para ese destino | **CONFLICTO**: algún archivo de destino existe con contenido distinto; **no se instaló ningún archivo** |
| `status` | sin instalación registrada, o todos los archivos `SIN CAMBIOS` | error técnico (manifiesto ilegible o ruta insegura) | algún archivo `MODIFICADO` o sustituido por un enlace (se conservará) |
| `doctor` | todos los controles en `PASS` | error técnico: falta `opencode.json`, la CLI `opencode` no existe, la salida no es JSON o un `debug` superó los 180 s | hay hallazgos (agentes, modos, modelo o configuración que no coinciden) |
| `uninstall` | desinstalación completa, o no había instalación registrada | error técnico | se conservaron archivos modificados; el registro se actualiza solo con esos archivos |
| `self-test` | `SELF-TEST COMPLETADO` | una aserción falló (no provocado en este entorno) | no aplica |

Verificado hoy: `install --dry-run` → 0; `install` → 0; `install` con
`opencode.json` distinto → 2 (`CONFLICTOS: no se instaló ningún archivo.`);
`status` sin cambios → 0; `status` con un archivo editado → 2; `uninstall`
limpio → 0; `uninstall` con un archivo editado → 2 (`Quedaron 1 archivos
modificados.`); `doctor` sin `opencode.json` → 1.

#### Protecciones y manifiesto

- **`opencode.json` nunca se sobrescribe**: si falta se crea con el de la
  fábrica, si es idéntico se conserva (`skipped`) y si es distinto el
  instalador aborta en `CONFLICTO` con código 2 **sin instalar nada**.
  Detalle completo en [Instalación de `opencode.json` con protección
  `CONFLICTO`](#instalación-de-opencodejson-con-protección-conflicto).
- **`AGENTS.md` nunca se sobrescribe**: si ya existe (archivo, enlace o lo
  que sea) se conserva intacto; no es conflicto y no aborta la instalación.
  Si lo creó la fábrica y nadie lo modificó, `uninstall` lo retira; si el
  usuario lo editó, se conserva.
- **Manifiesto de control**: cada destino tiene un manifiesto en
  `~/.local/state/opencode-software-factory/<clave>.json`, donde `<clave>` son
  los primeros 24 hexadecimales del SHA-256 de la ruta absoluta del destino.
  Guarda la ruta, el commit de la fábrica y el SHA-256 de cada archivo
  instalado. Solo puede existir uno por destino: mientras exista, `install`
  se niega a reinstalar (`Usa 'status' o 'uninstall' antes de reinstalar.`).
  La ubicación se puede cambiar con `OPENCODE_SOFTWARE_FACTORY_STATE` o
  `XDG_STATE_HOME`.
- La instantánea de `config/global-inline-agents.snapshot.json`, la
  configuración global del usuario y los MCP **no** se modifican ni se
  instalan en los proyectos.

### Uso dentro de OpenCode

La instalación añade al proyecto consumidor 5 comandos, 6 agentes y 10 skills
(más una skill de terceros). Tras instalar, reinicia la sesión de OpenCode en
el proyecto para que cargue los archivos nuevos.

#### Comandos (5)

| Comando | Agente | Qué hace |
| --- | --- | --- |
| `/planificar <tarea>` | `architect` | Inspecciona el proyecto real y produce un plan de implementación verificable, sin modificar nada |
| `/implementar <tarea>` | `implementer` | Lee el código, aplica cambios pequeños, añade/ajusta pruebas y ejecuta las verificaciones antes de reportar |
| `/verificar` | `tester` | Ejecuta build y tests reales y devuelve evidencia: comando exacto, código de salida y fallos; no modifica archivos |
| `/revisar` | `reviewer` | Revisa el diff actual en busca de defectos demostrables; solo lectura |
| `/calidad-java` | `tester` | Batería Java completa (build, tests, checkstyle, spotbugs, pmd, jacoco, OWASP) con códigos de salida reales e informe de evidencia |

#### Agentes (6) y sus modos

| Agente | Modo | Función |
| --- | --- | --- |
| `build` | `primary` | Coordinador por defecto (`default_agent: build`): recibe la tarea, detecta el proyecto, delega y entrega resultados verificados |
| `architect` | `all` | Planificación en solo lectura con evidencia verificable |
| `implementer` | `all` | Implementación con cambios pequeños y tests añadidos |
| `reviewer` | `all` | Revisión independiente del diff, sin modificar nada |
| `tester` | `all` | Ejecución real de build, tests y análisis estático, con evidencia |
| `cloud-arbiter` | `subagent` | Árbitro para discrepancias difíciles o fallos persistentes; no usar de forma rutinaria |

Los seis fijan `opencode-go/mimo-v2.6-flash` en su frontmatter; `doctor` lo
comprueba agente por agente.

#### Skills (10 en `.opencode/skills`)

Se cargan con la herramienta `skill` cuando la tarea lo pida:

| Skill | Cuándo se carga |
| --- | --- |
| `project-discovery` | Al empezar a trabajar en un repositorio desconocido |
| `implementation-plan` | Cuando la tarea toca varios archivos o el alcance es ambiguo |
| `independent-review` | Tras cualquier cambio no trivial, antes de declararlo terminado |
| `systematic-debugging` | Ante un fallo reproducible, un error o un test que falla |
| `test-and-repair` | Cuando build o tests fallan tras un cambio |
| `metric-collector` | Para registrar y comparar tiempos, cobertura y códigos de salida entre ejecuciones |
| `dependency-audit` | Al revisar vulnerabilidades (CVE), licencias o versiones de dependencias |
| `security-scan` | Al pedir SAST, detección de secretos o hardening de seguridad |
| `spring-boot-architecture` | Al crear, revisar o modificar un servicio Spring Boot |
| `java-build-quality` | Al verificar un proyecto Java o pedir cobertura/análisis estático |

Además, la skill de terceros `reverse-engineer-anything` se instala en
`.agents/skills/` (ingeniería inversa sobre artefactos ya compilados o
empaquetados); no la mantiene la fábrica.

#### Ejemplo de ciclo completo

1. El usuario escribe una tarea en `build` (agente `primary`).
2. `build` carga `project-discovery` (si no conoce el proyecto) y delega la
   planificación en `architect`, que inspecciona archivos, manifiestos y
   pruebas reales y devuelve un plan con evidencia y criterios de aceptación.
3. `build` delega la implementación en `implementer`, que lee el código antes
   de tocarlo, aplica cambios pequeños, añade pruebas y ejecuta las
   verificaciones.
4. `build` delega la verificación en `tester` (`/verificar` o
   `/calidad-java`), que devuelve comando exacto, código de salida y fallos.
5. `build` delega la revisión en `reviewer` (`/revisar`), que examina el diff
   real (`git status` + `git diff HEAD`) y reporta defectos demostrables sin
   modificar nada.
6. Si implementador y revisor discrepan, o un fallo persiste tras varios
   intentos, `build` puede convocar a `cloud-arbiter`.
7. Solo entonces se da la tarea por terminada, con la evidencia de los
   pasos 4 y 5 en el informe.

### Verificación y troubleshooting

| Comando | Propósito | Código esperado |
| --- | --- | --- |
| `jq -e . opencode.json` | JSON de la fábrica bien formado | `0` |
| `python3 -m py_compile scripts/factory.py` | Sintaxis del instalador | `0` |
| `python3 scripts/factory.py self-test` | Instalación/preservación/reversión en directorios temporales | `0`, salida `SELF-TEST COMPLETADO` |
| `bash scripts/verify-factory.sh` | Batería estructural completa (config, modelo, newline, plantilla, agentes, skills y su frontmatter, config y agentes efectivos de OpenCode, self-test) | `0` y 11 líneas `PASS` |
| `python3 scripts/factory.py status <proyecto>` | Estado de los archivos instalados | `0` sin cambios, `2` con cambios |
| `python3 scripts/factory.py doctor <proyecto>` | Comprobación funcional en el proyecto consumidor | `0` todo PASS, `2` hallazgos, `1` error técnico |
| `opencode debug config` / `opencode debug agents` | Configuración y agentes que OpenCode carga realmente | `0` con salida JSON |

Observado el 25/10/2026: `verify-factory.sh` → 0 con 11 `PASS`,
`py_compile` → 0, `self-test` → 0.

**`opencode debug agents` puede tardar en directorios recién instalados**: el
servicio de OpenCode tarda en cargar la configuración de una ubicación nueva,
y la primera invocación puede devolver `[]` o solo los agentes globales (por
ejemplo `build` con modelo `None`), lo que producía **falsos negativos** en
`doctor`. Comportamiento actual (corregido el 25/10/2026 en
`scripts/factory.py`): `doctor` reintenta **hasta 5 veces con 2 s de espera**
hasta que aparezcan los 6 agentes esperados, informando cada espera con una
línea `NOTA: ... (intento N/5); se reintenta en 2 s.`; solo tras agotar los
intentos informa los hallazgos con la respuesta disponible. Ejecutado hoy:
`install` + `doctor` inmediato → **0** (27 `PASS`, con un reintento en el
intento 1/5).

**Re-ejecutar `status`/`doctor` tras modificar archivos**:

- `status` → `2` y línea `MODIFICADO (se conservará)`: el archivo se editó
  respecto al manifiesto; `uninstall` lo conservará y actualizará el registro.
  Es el estado esperado tras personalizar un agente o comando.
- `doctor` valida el *frontmatter* de los agentes (id, modo, proveedor,
  modelo) y la configuración que OpenCode carga: editado un agente añadiendo
  una línea al final del cuerpo, `doctor` → `0` (comprobado hoy); si cambias
  `mode:` o `model:`, `doctor` → `2`.
- Si el manifiesto desaparece, `status` informa `Sin instalación registrada`
  → `0`, y `install` volverá a estar disponible.

**Permisos en ejecuciones no interactivas (`opencode run`, CI)**: según la
doc oficial de permisos de OpenCode (https://opencode.ai/v2/docs/permissions/)
rige **"last matching rule wins"** (gana la ÚLTIMA regla que coincide; si
ninguna coincide, el resultado es `ask`). En un cliente **no interactivo**
(`opencode run`, CI) un permiso que resuelve en `ask` **se auto-rechaza**
(`permission requested: shell (...); auto-rejecting`), y **"Any `deny` denies
the operation"**: si un comando compuesto (`cmd; echo EXIT=$?`, `bash -c '...'`)
produce varios recursos, basta con que una parte caiga en un `deny` para que
se bloquee la operación entera. Por eso los agentes llevan listas `allow`
explícitas de inspección y de build/tests **después** de los `deny` globales
(para que ganen por "last match") y `deny` explícitos de secretos al final.
En ejecuciones **interactivas** el TUI pregunta en lugar de auto-rechazar, y
existe el flag global `--auto` (`opencode run --auto ...`) que aprueba lo que
no esté denegado.

### Ejemplo real: demo Spring Boot (25 de octubre de 2026)

Proyecto: `/tmp/opencode/factory-demo/factory-demo` — Spring Boot **3.5.16**
con Gradle y JaCoCo (`id 'org.springframework.boot' version '3.5.16'`,
`id 'jacoco'`), generado con Spring Initializr. Manifiesto
`~/.local/state/opencode-software-factory/51c187548ef3be12270ce0b5.json`:
31 archivos, commit de la fábrica `4c431b0`.

Ejecutado hoy en ese proyecto:

- `python3 scripts/factory.py status /tmp/opencode/factory-demo/factory-demo`
  → **0**, 31 líneas `SIN CAMBIOS`.
- `python3 scripts/factory.py doctor /tmp/opencode/factory-demo/factory-demo`
  → **0**, 27 `PASS`, 0 `ERROR`, cierre
  `Doctor: la fábrica funciona en este proyecto.`
- `./gradlew build` (en el demo) → **0**, `BUILD SUCCESSFUL in 955ms`.

Reproducido hoy en un directorio nuevo (`/tmp/opencode/factory-guide-demo`)
para demostrar el flujo completo y limpio:

- `install` → **0** (31 archivos nuevos, manifiesto creado).
- `doctor` inmediato después → **0** (27 `PASS`, 1 `NOTA` de reintento).
- `status` → **0** (31 `SIN CAMBIOS`).
- `uninstall` → **0** (`Desinstalación completada. Archivos eliminados: 31`).

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

## Herramientas de calidad (CLI, sin servidor)

Estrategia adoptada: **CLI-first**. Toda la calidad se ejecuta con
herramientas de línea de comandos locales, sin servidor, sin contenedores y
sin credenciales en el repositorio. La skill `java-build-quality` (y el
comando `/calidad-java`) son la referencia operativa.

### Comandos exactos (Maven / Gradle)

Usa el wrapper del proyecto si existe (`./mvnw` / `./gradlew`); si no, el
`mvn`/`gradle` del sistema y dilo en el informe. `-B` = Maven no interactivo.

| Propósito | Maven | Gradle |
| --- | --- | --- |
| Tests unitarios | `mvn -B test` | `./gradlew test` |
| Build completo y verificación (tests + cualquier plugin ligado a las fases `verify`/`check`) | `mvn -B verify` | `./gradlew build` y `./gradlew check` |
| Estilo | `mvn checkstyle:check` | `./gradlew checkstyleMain` |
| Estática (bugs) | `mvn spotbugs:check` | `./gradlew spotbugsMain` |
| Estática (reglas) | `mvn pmd:check` | `./gradlew pmdMain` |
| Cobertura (informe) | `mvn jacoco:report` | `./gradlew jacocoTestReport` |
| Auditoría OWASP de dependencias | `mvn org.owasp:dependency-check-maven:check` | `./gradlew dependencyCheckAnalyze` |
| Árbol de dependencias | `mvn dependency:tree` | `./gradlew dependencies` |
| SAST / secretos (si están instalados) | `semgrep --config auto .`, `bandit -r .`, `truffleHog .`, `detect-secrets scan` | ídem |

La última fila **no se ejecutó en este entorno**: ninguna de esas
herramientas SAST está instalada en esta máquina.

### Dónde quedan los informes

| Herramienta | Maven | Gradle |
| --- | --- | --- |
| Cobertura HTML | `target/site/jacoco/index.html` | `build/reports/jacoco/test/html/index.html` |
| Cobertura XML | `target/site/jacoco/jacoco.xml` | `build/reports/jacoco/test/test/index.xml` |
| Checkstyle | `target/checkstyle-result.xml` | `build/reports/checkstyle/main.html` |
| SpotBugs | `target/spotbugsXml.xml` | `build/reports/spotbugs/main.html` |
| PMD | `target/pmd.xml` | `build/reports/pmd/main.html` |
| OWASP dependency-check | `target/dependency-check-report.html` | `build/reports/dependency-check/` |
| Tests (JUnit XML/HTML) | `target/surefire-reports/` | `build/reports/tests/test/` |

Los informes solo existen tras ejecutar la herramienta correspondiente:
**nunca cites un informe que no se haya generado**.

### Qué permisos habilitan la batería

En `tester` (`.opencode/agents/tester.md`), con edición denegada
(`edit * → deny`):

- Por defecto `shell * → ask`; la lista `effect: allow` habilita **sin
  aprobación**: `./gradlew test|build|clean test|check|jacocoTestReport|
  spotbugsMain|checkstyleMain|pmdMain|dependencies|spotbugsTest` (además de
  `./gradlew dependencyCheckAnalyze`), `./mvnw -B -v`, `./mvnw test|-B
  test|verify|-B verify|clean test|-B clean test|checkstyle:*|pmd:*|
  spotbugs:*|jacoco:*|org.owasp:dependency-check-maven:*|dependency:*`, más
  las variantes `-B` del wrapper (`./mvnw -B checkstyle:*|pmd:*|spotbugs:*|
  jacoco:*|org.owasp:dependency-check-maven:*`),
  `gradle test|check|clean test|build|jacocoTestReport`, `mvn test|verify|
  -B test|-B verify|-B clean test`, `mvn checkstyle:*|spotbugs:*|pmd:*|
  jacoco:*|dependency:*`, `mvn org.owasp:dependency-check-maven:*`, más las
  variantes `-B` de Maven (`mvn -B checkstyle:*|pmd:*|spotbugs:*|jacoco:*|
  org.owasp:dependency-check-maven:*|dependency:*`), además de
  pytest/unittest/ruff, npm/tsc/eslint, `make test` y `make build` (no existe
  regla para `make` a secas: queda en `ask`), `bash`/`sh` y las lecturas de
  git (`status`, `diff`, `log`, `show`).
- Denegados y por tanto excluidos: `sudo`, `rm`, `rm -rf`, `git push`,
  `git commit`, `git checkout`, `git reset`, `git restore`, `curl`, `wget`,
  `bash -c`, `sh -c`, las redirecciones de escritura —las reglas `deny`
  `*>` y `*>*`, que casan cualquier comando cuyo texto contenga `>` (también
  `2>&1`, `2>/dev/null` o un `>` presente dentro de un argumento, p. ej. un
  patrón de `grep`)—, cualquier acceso a `*.env*` y toda edición de
  archivos.

En `reviewer` (`.opencode/agents/reviewer.md`), también sin edición y con
`shell * → deny` global, la lista de permitidos son **41 reglas `allow`**:
lectura de git (`status`, `log`, `diff`, `show`), pruebas (`pytest`,
`python3 -m pytest`, `python3 -m unittest`, `./gradlew test`, `./mvnw test`,
`./mvnw -B test`, `mvn test`, `mvn -B test`), inspección de ficheros (`ls`,
`cat`, `grep`, `head`, `tail`, `sed -n`, `wc`, `sort`, `uniq`, `cut`, `stat`,
`diff`, `du`, `file`, `which`, `echo`, `pwd`), comandos de versión o build
mínimos (`java -version`, `mvn -version`, `gradle --version`,
`./gradlew --version|tasks|check|assemble|bootJar`) y las verificaciones de
la fábrica (`bash scripts/verify-factory.sh`,
`python3 scripts/factory.py self-test`, `python3 -m py_compile *`,
`jq -e *`). **No hay regla para `find`** (usa las herramientas `glob` y
`grep`), **ni para `bash` genérico** (solo existe el `allow` puntual
`bash scripts/verify-factory.sh`), ni para el resto de la batería Java
(checkstyle, spotbugs, pmd, jacoco, OWASP): el revisor se apoya en los
informes y códigos que produce `tester`.

`./gradlew bootRun` **no tiene ninguna regla específica**: en `tester` (cuya
regla general es `shell * → ask`) resuelve en `ask` —en ejecución no
interactiva se auto-rechaza y en el TUI pregunta— y en `architect`/`reviewer`
cae en su regla global `shell * → deny`. En ningún caso arranca el servidor
sin aprobación; para probar en vivo se usa a mano o con `--auto`/interactivo.

#### Nota de seguridad sobre los permisos de shell

Corrección aplicada el 25 de octubre de 2026 tras defectos **demostrados** en
ejecución real (no hipótesis):

- **`find` no está permitido por `shell` en ningún agente**: `-delete` y
  `-exec` permitían mutar el árbol de ficheros desde agentes de solo lectura
  (demostrado: `find scripts -maxdepth 1 -name verify-factory.sh -delete` borró
  el fichero sin ninguna denegación). Para localizar ficheros usa las
  herramientas `glob` y `grep`.
- **En `architect` y `reviewer` toda redirección queda denegada**: existe una
  regla `shell` `deny` cuyo patrón casaba cualquier comando que contenga `>`,
  colocada después de los `deny` de `*.env*` y antes de la regla final
  `*.env*` → `deny`. Así `echo HOLA > fichero` deja de escribir archivos desde
  un agente de solo lectura (antes lo escribía). Si una tarea legítima necesita
  redirigir, repórtalo en vez de ejecutarlo.
- **En `tester`, `bash -c *` y `sh -c *` quedan denegados** para que no eludan
  sus `deny` (`bash -c 'rm ...'`, `bash -c 'curl ...'`, `bash -c 'git push ...'`).
  Las redirecciones de escritura las cubren las reglas `deny` `*>` y `*>*`,
  equivalentes: casan cualquier comando cuyo texto contenga `>`, así que
  también bloquean `2>&1`, `2>/dev/null` y un `>` presente dentro de un
  argumento (p. ej. un patrón de `grep`). **No rompe el flujo obligatorio**:
  ninguno de los comandos que prescribe `/calidad-java` (los siete pasos de
  la batería) ni ninguna de las verificaciones (`bash
  scripts/verify-factory.sh`, `python3 scripts/factory.py self-test`,
  `python3 -m py_compile *`, `jq -e *`) lleva `>` en su texto. Si necesitas
  comparar texto, usa la herramienta `grep` (o `glob`) en lugar de la shell,
  o ejecuta el comando sin redirigir. El `allow`
  `bash scripts/verify-factory.sh` sigue funcionando porque su texto tampoco
  contiene `>`.
- Las reglas `*.env*` → `deny` son las **últimas** reglas `shell` de
  `architect`, `reviewer` y `tester`: cubren `grep`, `sed`, `ls`, etc. sobre
  `.env`, no solo `cat`/`head`/`tail`.

### Qué está verificado hoy (25 de octubre de 2026)

Ejecutado en el demo Spring Boot (`/tmp/opencode/factory-demo/factory-demo`,
Gradle 8.14.5 + JDK 17.0.20 del PATH):

| Comando | Código | Resultado observado |
| --- | --- | --- |
| `./gradlew build` | `0` | `BUILD SUCCESSFUL in 955ms` |
| `./gradlew check` | `0` | `BUILD SUCCESSFUL in 636ms` |
| `./gradlew jacocoTestReport` | `0` | informe en `build/reports/jacoco/test/html/index.html` |
| `./gradlew spotbugsMain` | `1` | `Task 'spotbugsMain' not found in root project 'factory-demo'` (plugin no declarado) |
| `./gradlew checkstyleMain` | `1` | `Task 'checkstyleMain' not found...` (idem) |
| `./gradlew pmdMain` | `1` | `Task 'pmdMain' not found...` (idem) |
| `./gradlew dependencyCheckAnalyze` | `1` | `Task 'dependencyCheckAnalyze' not found...` (idem) |

Ejecutado sobre una **copia** de `springboot-maven/` en `/tmp` (Maven 3.9.16,
proyecto de prueba que solo declara el plugin compilador):

| Comando | Código | Resultado observado |
| --- | --- | --- |
| `mvn -B test` | `0` | `BUILD SUCCESS`, `No tests to run` |
| `mvn -B verify` | `0` | `BUILD SUCCESS` |
| `mvn -B checkstyle:check` | `1` | resuelve el plugin por prefijo y ejecuta con reglas por defecto: `You have 5 Checkstyle violations`; informe en `target/checkstyle-result.xml` |
| `mvn -B spotbugs:check` | `0` | `BUILD SUCCESS`; informe en `target/spotbugsXml.xml` |
| `mvn -B pmd:check` | `0` | `BUILD SUCCESS` |
| `mvn -B jacoco:report` | `1` | `No plugin found for prefix 'jacoco'`: sin `jacoco-maven-plugin` en el `pom.xml` no hay informe |

También verificado hoy: para cada una de `semgrep`, `bandit`,
`sonar-scanner`, `codeql`, `truffleHog` y `detect-secrets`,
`command -v <herramienta>` → **no encontrado**.

**No ejecutado en este entorno** (señálalo siempre como tal):

- `mvn org.owasp:dependency-check-maven:check` y
  `./gradlew dependencyCheckAnalyze`: no se ejecutaron; la primera ejecución
  descarga la base NVD (minutos y red). En el demo, además, falla por no
  tener el plugin declarado.
- Batería Maven sobre un proyecto que declare `checkstyle`, `spotbugs`, `pmd`
  y `jacoco` en su `pom.xml` (los resultados de arriba son con plugins
  resueltos por prefijo o sin configurar).
- Cualquier herramienta SAST/secretos de la tabla anterior: no instalada.
- Pruebas con Testcontainers u otros contenedores: Docker no está instalado
  (`docker --version` → 127).
- La versión concreta de los plugins de build resueltos por descriptor y la
  ejecución real del servidor MCP `playwright`.

### Qué requiere configuración del proyecto

Si el proyecto no declara la herramienta, el resultado es
`Task ... not found` o `No plugin found for prefix` (códigos `1` de arriba).
En ese caso, la skill `java-build-quality` obliga a **reportar "no
disponible" y proponer añadir el plugin con versión fijada**; si se decide
probarlo igualmente por descriptor, se informa el código de salida real y se
deja claro que es una ejecución **sin configuración del proyecto** (reglas
por defecto). Nunca se simula un resultado ni se inventa un porcentaje de
cobertura.

## SonarQube y MCPs (opcional, requiere infraestructura)

### Por qué no está SonarQube hoy

- SonarQube necesita un **servidor propio o una cuenta SonarCloud con
  token**; no es una CLI autocontenida.
- En este entorno **no hay Docker** (`docker --version` → 127), **no hay
  servidor SonarQube** y **`sonar-scanner` no está instalado**
  (`command -v sonar-scanner` → no encontrado). Todo verificado el
  25/10/2026.
- Por tanto, la estrategia adoptada es **CLI-first** (sección anterior):
  checkstyle, spotbugs, pmd, jacoco, OWASP dependency-check y semgrep/bandit
  cuando estén instalados, todo local y reproducible con un comando.

### Si algún día se adopta

- La configuración del escáner, la URL del servidor y el **token van en la
  configuración global del usuario** (`~/.config/opencode/opencode.json`) o
  en variables de entorno, **nunca en el `opencode.json` de la fábrica** ni
  en ningún archivo versionado del repositorio: evita secretos en Git y
  mantiene separada la fábrica de la infraestructura personal.
- El `opencode.json` que instala la fábrica sigue siendo solo
  `model`, `default_agent` y `compaction` (verificado hoy con `jq -e
  opencode.json` → 0).

### Decisiones registradas sobre MCP

- **MCPs comunitarios de análisis Java / SonarQube evaluados y descartados**
  por criterios de licencia, infraestructura necesaria (servidor/token) y
  mantenimiento de la comunidad: ninguno se instaló. Estado: **no verificado**
  (no se ejecutó ninguno, no se comprobó su licencia ni su comportamiento en
  esta máquina).
- **`context7`**: MCP de documentación disponible globalmente en este
  entorno; **no lo gestiona la fábrica** ni se instala con ella. Estado:
  presente en la configuración global (ver abajo).
- **`playwright`**: MCP de navegador configurado en la **config global del
  usuario**, no en la de la fábrica. Estado: presente en la configuración
  global; la navegación real por MCP **no se ejecutó** en esta sesión.
- Servidores MCP declarados hoy en la config global (comando real):
  `jq -r '.mcp.servers | keys[]' ~/.config/opencode/opencode.json` →
  `context7`, `playwright`, `rea` (código 0, 25/10/2026). `rea` acompaña a
  la skill de terceros `reverse-engineer-anything` y tampoco lo gestiona la
  fábrica.

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
  `python3 scripts/factory.py self-test|status|doctor`, builds y tests
  habituales: Gradle (`./gradlew test|build|clean test|check|
  jacocoTestReport|spotbugsMain|checkstyleMain|pmdMain|dependencies|
  spotbugsTest|dependencyCheckAnalyze`, `gradle test|check|clean test|build|
  jacocoTestReport`), Maven con wrapper (`./mvnw -B -v`, `./mvnw test|-B
  test|verify|-B verify|clean test|-B clean test|checkstyle:*|pmd:*|
  spotbugs:*|jacoco:*|org.owasp:dependency-check-maven:*|dependency:*`, más
  las variantes `-B` `./mvnw -B checkstyle:*|pmd:*|spotbugs:*|jacoco:*|
  org.owasp:dependency-check-maven:*`), Maven del sistema (`mvn test|verify`,
  `mvn -B test|verify|-B clean test`, `mvn checkstyle:*|spotbugs:*|pmd:*|
  jacoco:*|dependency:*`, `mvn org.owasp:dependency-check-maven:*`, más las
  variantes `-B` `mvn -B checkstyle:*|pmd:*|spotbugs:*|jacoco:*|
  org.owasp:dependency-check-maven:*|dependency:*`), Python
  (`python3 -m pytest`, `pytest`, `python3 -m unittest`,
  `python3 -m compileall`, `ruff check`), Node/TS (`npm test`,
  `npm run test`, `npm ci`, `npm install`, `npx tsc`, `tsc`, `eslint`,
  `node --test`), `make test|build`, `bash`/`sh`, auditorías de dependencias
  (`npm audit`, `pnpm audit`, `yarn audit`, `pip-audit`, `safety check`,
  `cargo audit`, `govulncheck`) y SAST/secretos (`semgrep`, `bandit`,
  `codeql`, `gosec`, `sonar-scanner`, `truffleHog`, `git-secrets`,
  `detect-secrets`, `cargo clippy`).
- **Denegados explícitamente** (`effect: deny`, y por tanto prevalecen):
  `sudo`, `rm`, `rm -rf`, `git push`, `git commit`, `git checkout`,
  `git reset`, `git restore`, `curl`, `wget`, `bash -c`, `sh -c` (para que no
  eludan los `deny` anteriores), las redirecciones de escritura, que cubren
  las reglas `*>` y `*>*` (bloquean cualquier comando cuyo texto contenga
  `>`), cualquier comando sobre `*.env*` (cubre también `grep`, `sed`,
  `ls`...) y toda edición de archivos. Las reglas `*.env*` son las últimas
  reglas `shell` de la lista.
- **Todo lo demás** sigue pidiendo aprobación (`shell * -> ask`). `find` ya no
  está permitido: usa `glob`/`grep` (ver
  [Nota de seguridad sobre los permisos de shell](#nota-de-seguridad-sobre-los-permisos-de-shell)).

La lista de comandos permitidos sin aprobación es la que habilita la batería
descrita en [Herramientas de calidad](#herramientas-de-calidad-cli-sin-servidor);
la ausencia de una herramienta en el PATH se informa como "no disponible",
nunca como ejecutada.

Archivo: `.opencode/agents/tester.md`.

### Modelo y verificación de la fábrica

La configuración del repositorio y el script `scripts/verify-factory.sh`
usan `opencode-go/mimo-v2.6-flash` como modelo configurado.

El script `bash scripts/verify-factory.sh` valida la configuración JSON, el
modelo fijado en los seis agentes, el newline final de los archivos
instalables, la plantilla `templates/AGENTS.md`, la estructura de agentes y
skills, el frontmatter (`---`, `name` y `description`) de **todas** las
skills (11: 10 locales de `.opencode/skills` más la de terceros
`reverse-engineer-anything`, en `.agents/skills`), la carga de la
configuración de OpenCode, el reconocimiento de los agentes y, al final, el
self-test del instalador. Esta comprobación es
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
  lo detecta, lo informa con una línea `NOTA` y reintenta. **Actualizado el
  25/10/2026**: el reintento pasó a ser de hasta 5 intentos con 2 s de
  espera (además, la respuesta parcial puede ser `[]` o solo los agentes
  globales, por ejemplo `build` con modelo `None`); el detalle y la salida
  real están en [Guía de uso](#guía-de-uso).
- `python3 scripts/factory.py doctor <directorio sin opencode.json>` →
  código 1 con mensaje explicativo.
- `bash scripts/verify-factory.sh` → código 0, todos los pasos en `PASS`.
- Estas validaciones no equivalen a ejecutar las pruebas de un proyecto Java
  ni a verificar la calidad de todas las respuestas generadas por los agentes.
- Validaciones del 25 de octubre de 2026 (batería completa con códigos
  reales, demo Spring Boot incluido): ver
  [Guía de uso](#guía-de-uso) y
  [Ejemplo real](#ejemplo-real-demo-spring-boot-25-de-octubre-de-2026).

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

La fábrica instala hoy **10 skills** en `.opencode/skills/` (además de la
skill de terceros `reverse-engineer-anything`, en `.agents/skills/`, que no
mantiene la fábrica):

- **project-discovery**: descubre y analiza un proyecto desconocido antes de
  modificarlo, con evidencia de archivos leídos y comandos ejecutados.
- **implementation-plan**: divide una tarea en pasos pequeños y
  verificables, con archivos afectados y criterios de aceptación.
- **independent-review**: método de revisión independiente de los cambios
  antes de dar trabajo por terminado.
- **systematic-debugging**: diagnostica errores reproducibles con evidencia,
  hipótesis y pruebas, sin ocultar síntomas.
- **test-and-repair**: ejecuta build y tests, interpreta los fallos reales y
  corrige hasta que pasen o hasta agotar los intentos.
- **metric-collector**: registra etapa, comando exacto, duración, código de
  salida y timestamp para comparar ejecuciones.
- **dependency-audit**: audita dependencias en busca de vulnerabilidades
  (CVE), licencias incompatibles y versiones desactualizadas.
- **security-scan**: escaneo de seguridad estático (SAST) y detección de
  secretos con las herramientas disponibles en el proyecto.
- **spring-boot-architecture**: estructura, capas, perfiles, validación,
  manejo de errores y testing de servicios Spring Boot.
- **java-build-quality**: comandos exactos de la batería de calidad Java
  (Maven/Gradle), rutas de informes y qué hacer si falta una herramienta.

Todas las skills están incluidas en la validación de
`scripts/verify-factory.sh`: las 10 locales de `.opencode/skills` y la de
terceros `reverse-engineer-anything`, de `.agents/skills` (11 en total).
Desde el 25/10/2026 esa validación comprueba el frontmatter de **todas** las
skills (`---` de apertura y cierre, `name` igual
al directorio y `description` no vacía): sin frontmatter OpenCode **no carga
la skill**. Tres skills (`metric-collector`, `dependency-audit` y
`security-scan`) carecían de él y por eso no aparecían en el listado de
skills disponibles; se les añadió `---`/`name`/`description` y ahora cargan.

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
- Ejecutar la batería de calidad completa (checkstyle, spotbugs, pmd, jacoco,
  OWASP dependency-check) sobre un proyecto **que declare esos plugins**, con
  sus informes y códigos de salida reales. Hoy solo se ejecutó lo que el
  demo Gradle soporta (`build`, `check`, `jacocoTestReport` → 0; los cuatro
  tasks de análisis → 1 por no estar declarados) y, en Maven, plugins
  resueltos por prefijo sobre una copia de `springboot-maven/`.
- Instalar y ejecutar una herramienta SAST/secretos (p. ej. `semgrep`) para
  validar `security-scan` de extremo a extremo: ninguna está instalada en
  esta máquina (`command -v` → no encontrado).
- Decidir, si acaso, la adopción de SonarQube o de un MCP de calidad:
  requiere servidor o cuenta Cloud con token, y su configuración debería ir
  en la config global del usuario. Ninguno está verificado en este entorno.
- Probar el flujo con contenedores (Testcontainers) cuando haya Docker en la
  máquina; hoy `docker --version` → 127.

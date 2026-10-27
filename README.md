
# OpenCode Software Factory

Repositorio fuente de la fábrica de software multiagente: un instalador
reversible que lleva agentes, comandos, skills y configuración a cualquier
proyecto consumidor de OpenCode.

## Índice

- [Objetivos](#objetivos)
- [Estructura del repositorio](#estructura-del-repositorio)
- [Guía de uso](#guía-de-uso)
  - [Requisitos previos](#requisitos-previos)
  - [Comandos del instalador](#comandos-del-instalador)
  - [Uso dentro de OpenCode](#uso-dentro-de-opencode)
  - [Calidad Java](#calidad-java)
  - [Permisos de los agentes](#permisos-de-los-agentes)
  - [Verificación y troubleshooting](#verificación-y-troubleshooting)
- [Modelo de referencia](#modelo-de-referencia)
- [MCP y configuración global](#mcp-y-configuración-global)
- [Principios de calidad](#principios-de-calidad)
- [Separación entre fábrica y proyectos consumidores](#separación-entre-fábrica-y-proyectos-consumidores)
- [Limitaciones conocidas](#limitaciones-conocidas)

## Objetivos

- Coordinar análisis, planificación, implementación y revisión.
- Mantener agentes, skills y comandos versionados.
- Exigir evidencia real de compilaciones y pruebas.
- Separar la infraestructura de la fábrica de los proyectos de trabajo.
- Permitir instalación y reversión controladas.

## Estructura del repositorio

- `.opencode/agents/`: 7 agentes Markdown (`build`, `architect`,
  `implementer`, `reviewer`, `tester`, `cloud-arbiter`, `reverse`).
- `.opencode/commands/`: 5 comandos (`/planificar`, `/implementar`,
  `/revisar`, `/verificar`, `/calidad-java`).
- `.opencode/skills/`: 10 skills de la fábrica (un directorio con
  `SKILL.md` por skill).
- `.agents/skills/`: 1 skill de terceros (`reverse-engineer-anything`, 8
  ficheros) que la fábrica instala pero no mantiene.
- `config/global-inline-agents.snapshot.json`: respaldo histórico de los
  agentes `build` y `reverse` tal como estaban definidos en la
  configuración global del usuario antes de la centralización (oct 2026);
  esas definiciones ya viven en este repositorio y el snapshot se conserva
  solo como referencia; **no** se instala en los proyectos.
- `opencode.json`: configuración predeterminada de este repositorio
  (`model`, `default_agent`, `compaction`, `permissions`, `providers` y
  `mcp`: los 3 MCP con sus rutas locales viven aquí desde la
  centralización).
- `templates/AGENTS.md`: plantilla de instrucciones que la fábrica instala
  en los proyectos consumidores.
- `templates/quality/`: plantillas de calidad Java (Maven y Gradle) que
  `factory.py quality --apply` inyecta en el build del proyecto; incluye su
  propio `README.md` con el uso resumido.
- `scripts/factory.py`: instalador y utilidades (`install`, `status`,
  `doctor`, `uninstall`, `quality`, `self-test`); solo librería estándar de
  Python.
- `scripts/verify-factory.sh`: batería estructural del repositorio.
- `AGENTS.md`, `LICENSE`: instrucciones propias de este repositorio y
  licencia.

El repositorio **no** incluye proyectos de ejemplo: los cuatro stacks
soportados (Java/Maven, Java/Gradle, TypeScript y Python) se validan
instalando la fábrica sobre un proyecto consumidor de ese stack, y el
`self-test` trabaja con directorios temporales aislados.

## Guía de uso

### Requisitos previos

| Requisito | Versión en esta máquina | Comprobación |
| --- | --- | --- |
| Python 3 | 3.14.4 | `python3 --version` |
| CLI de OpenCode v2 | v2.0.31 | `opencode --version` |
| git | 2.53.0 | `git --version` |
| Plan OpenCode Go | conectado con `/connect` → **OpenCode Go** | comprobación interactiva en la CLI |
| JDK (para la batería Java) | `java -version` → OpenJDK 17.0.20 (Temurin 17.0.20+8); hay además instalados `21.0.12+1.1-tem` y `25.0.4-tem` | `java -version` |
| Maven / Gradle | 3.9.16 / 8.14.5 | `mvn -version`, `gradle --version` |
| Docker | **no instalado** | `docker --version` → 127 (command not found) |

- El instalador usa solo la librería estándar de Python: no hay
  dependencias que instalar con `pip`, y **la fábrica no instala ninguna
  herramienta en el sistema** (solo copia ficheros en el proyecto).
- El instalador es agnóstico del stack: copia agentes, comandos y skills
  sin interpretar el proyecto. Los permisos sin aprobación cubren Java
  (Maven/Gradle), Python (pytest, unittest, ruff), Node/TypeScript (npm,
  tsc, eslint) y `make`.
- Sin plan de modelo conectado la instalación funciona, pero los agentes no
  podrán responder: conecta con `/connect` → **OpenCode Go** antes de
  delegar.
- Docker ausente implica que Testcontainers y cualquier prueba que necesite
  contenedores no puede ejecutarse en esta máquina (se marca como no
  ejecutable, nunca como pasada).

### Comandos del instalador

```bash
# 1. Vista previa: no modifica nada (muestra lo que se copiaría)
python3 scripts/factory.py install --dry-run <ruta-del-proyecto>

# 2. Instalación real
python3 scripts/factory.py install <ruta-del-proyecto>

# 3. Comprobación de archivos y de comportamiento real
python3 scripts/factory.py status   <ruta-del-proyecto>
python3 scripts/factory.py doctor   <ruta-del-proyecto>

# 4. Plugins de calidad Java en el build del proyecto (ver "Calidad Java")
python3 scripts/factory.py quality  <ruta-del-proyecto>            # solo informa
python3 scripts/factory.py quality  <ruta-del-proyecto> --apply    # respalda e inyecta

# 5. Reversión: retira únicamente los archivos sin modificar
python3 scripts/factory.py uninstall <ruta-del-proyecto>

# 6. Pruebas del propio instalador, en directorios temporales aislados
python3 scripts/factory.py self-test
```

`install` copia 32 ficheros en un proyecto nuevo: 7 agentes + 5 comandos +
10 skills de la fábrica (un `SKILL.md` por skill) + 8 ficheros de la skill
de terceros `reverse-engineer-anything` + `opencode.json` + `AGENTS.md`.

Qué hace cada comando:

- **`install`**: instala agentes, comandos, skills, `opencode.json` y (solo
  si falta) `AGENTS.md`, y registra la instalación en un manifiesto.
  `--dry-run` muestra lo que haría sin tocar nada. No puede reinstalar
  sobre un destino con manifiesto: usa `status` o `uninstall` antes.
- **`status`**: compara los archivos instalados con el manifiesto y
  etiqueta cada uno (`SIN CAMBIOS`, `MODIFICADO (se conservará)`,
  `ENLACE SIMBÓLICO (se conservará)` o `AUSENTE`).
- **`doctor`**: comprueba que la fábrica funciona realmente en el proyecto
  consumidor usando el CLI de OpenCode (`opencode debug agents` y
  `opencode debug config`): los 7 agentes reconocidos con su modo,
  proveedor y modelo correctos, y la carga del `opencode.json` del proyecto
  con `default_agent: build` y el modelo esperado. Son 31 controles (4 por
  agente × 7, más 3 de configuración).
- **`uninstall`**: retira los archivos instalados que nadie modificó y
  conserva los editados, dejando constancia de ellos en el manifiesto.
- **`quality`**: detecta los plugins de calidad del build del proyecto y
  muestra un informe `PRESENTE`/`FALTA` con los comandos de ejecución; sin
  `--apply` no escribe nada.
- **`self-test`**: instala, comprueba la preservación de ficheros del
  consumidor y revierte en directorios temporales propios (no usa ningún
  directorio del repo).

#### Códigos de retorno

| Comando | `0` | `1` | `2` |
| --- | --- | --- | --- |
| `install` | instalación completada (o `--dry-run` sin tocar nada) | error técnico: destino inválido, ruta insegura, fuente ausente o manifiesto ya existente para ese destino | **CONFLICTO**: algún archivo de destino existe con contenido distinto; **no se instaló ningún archivo** |
| `status` | sin instalación registrada, o todos los archivos `SIN CAMBIOS` | error técnico (manifiesto ilegible o ruta insegura) | algún archivo `MODIFICADO` o sustituido por un enlace (se conservará) |
| `doctor` | todos los controles en `PASS` | error técnico: falta `opencode.json`, la CLI `opencode` no existe, la salida no es JSON o un `debug` superó los 180 s | hay hallazgos (agentes, modos, modelo o configuración que no coinciden) |
| `uninstall` | desinstalación completa, o no había instalación registrada | error técnico | se conservan los archivos modificados y el manifiesto pasa a registrar solo esos archivos |
| `quality` | todo lo gestionable está presente (sin `--apply`) o quedó inyectado (con `--apply`) | error técnico: ruta inválida, directorio sin `pom.xml`/`build.gradle`, plantilla ausente o error de lectura | falta algún plugin, el build es ambiguo (`pom.xml` + `build.gradle` conviven), es `build.gradle.kts`, el `pom.xml` no es XML bien formado, el fichero no es UTF-8 o la inyección no sería segura: **no se modificó nada** |
| `self-test` | salida `SELF-TEST COMPLETADO` | una aserción falla y la ejecución se interrumpe | no aplica |

#### Protecciones y manifiesto

- **`opencode.json` nunca se sobrescribe**: si falta se crea con el de la
  fábrica; si es idéntico se conserva (`skipped`); si es distinto el
  instalador aborta en `CONFLICTO` con código 2 **sin instalar nada** (ni
  el resto de archivos se copian). El fichero que instala la fábrica
  contiene `model`, `default_agent`, `compaction`, `permissions`,
  `providers` y `mcp` (ver [MCP y configuración
  global](#mcp-y-configuración-global)).
- **`AGENTS.md` nunca se sobrescribe**: si ya existe (archivo, enlace o lo
  que sea) se conserva intacto; no es conflicto y no aborta la instalación.
  Si lo creó la fábrica y nadie lo modificó, `uninstall` lo retira; si el
  usuario lo editó, se conserva.
- **Manifiesto de control**: cada destino tiene un manifiesto en
  `~/.local/state/opencode-software-factory/<clave>.json`, donde `<clave>`
  son los primeros 24 hexadecimales del SHA-256 de la ruta absoluta del
  destino. Guarda la ruta, el commit de la fábrica y el SHA-256 de cada
  archivo instalado. Solo puede existir uno por destino: mientras exista,
  `install` se niega a reinstalar (`Usa 'status' o 'uninstall' antes de
  reinstalar.`). La ubicación se puede cambiar con
  `OPENCODE_SOFTWARE_FACTORY_STATE` o `XDG_STATE_HOME`.
- La instantánea de `config/global-inline-agents.snapshot.json` es un
  respaldo histórico y **no** se instala en los proyectos. La
  configuración global del usuario no se modifica. Los MCP **sí** se
  instalan en los proyectos: viven en el `opencode.json` de la fábrica
  (ver [MCP y configuración global](#mcp-y-configuración-global)).

### Uso dentro de OpenCode

La instalación añade al proyecto consumidor 5 comandos, 7 agentes y 10
skills (más una skill de terceros). Tras instalar, reinicia la sesión de
OpenCode en el proyecto para que cargue los ficheros nuevos.

#### Comandos (5)

| Comando | Agente | Qué hace |
| --- | --- | --- |
| `/planificar <tarea>` | `architect` | Inspecciona el proyecto real y produce un plan de implementación verificable, sin modificar nada |
| `/implementar <tarea>` | `implementer` | Lee el código, aplica cambios pequeños, añade/ajusta pruebas y ejecuta las verificaciones antes de reportar |
| `/verificar` | `tester` | Ejecuta build y tests reales y devuelve evidencia: comando exacto, código de salida y fallos; no modifica archivos |
| `/revisar` | `reviewer` | Revisa el diff actual en busca de defectos demostrables; solo lectura |
| `/calidad-java` | `tester` | Batería Java completa (build, tests, checkstyle, spotbugs, pmd, jacoco, OWASP) con códigos de salida reales e informe de evidencia |

Nota: los comandos `/preguntar` y `/explicar-codigo`, que vivían en la
configuración global del usuario, se retiraron a propósito durante la
centralización (octubre de 2026) y ya no están disponibles (solo quedan en
un respaldo externo al repositorio).

#### Agentes (7) y sus modos

| Agente | Modo | Función |
| --- | --- | --- |
| `build` | `primary` | Coordinador por defecto (`default_agent: build`): recibe la tarea, detecta el proyecto, delega y entrega resultados verificados |
| `architect` | `all` | Planificación en solo lectura con evidencia verificable: inspecciona instrucciones, manifiestos, código y pruebas, y distingue hechos verificados, inferencias y datos desconocidos |
| `implementer` | `all` | Implementación con cambios pequeños, tests añadidos y verificación ejecutada |
| `reviewer` | `all` | Revisión independiente del diff (`git status` + `git diff HEAD`), sin modificar nada |
| `tester` | `all` | Ejecución real de build, tests y análisis estático, con evidencia: comando exacto, código de salida y pruebas no ejecutadas |
| `cloud-arbiter` | `subagent` | Árbitro para discrepancias difíciles o fallos persistentes; no usar de forma rutinaria |
| `reverse` | `primary` | Ingeniería inversa sobre binarios y artefactos ya compilados, con el MCP `rea` y las herramientas `rea_*` |

Los siete fijan `opencode-go/mimo-v2.6-flash` en su frontmatter; `doctor`
lo comprueba agente por agente.

#### Skills (10 en `.opencode/skills`)

Se cargan con la herramienta `skill` cuando la tarea lo pida:

| Skill | Cuándo se carga |
| --- | --- |
| `project-discovery` | Al empezar a trabajar en un repositorio desconocido: exige que las conclusiones se apoyen en ficheros leídos o comprobaciones ejecutadas y revisar el estado de Git |
| `implementation-plan` | Cuando la tarea toca varios archivos o el alcance es ambiguo |
| `independent-review` | Tras cualquier cambio no trivial, antes de declararlo terminado |
| `systematic-debugging` | Ante un fallo reproducible, un error o un test que falla |
| `test-and-repair` | Cuando build o tests fallan tras un cambio |
| `metric-collector` | Para registrar y comparar tiempos, cobertura y códigos de salida entre ejecuciones |
| `dependency-audit` | Al revisar vulnerabilidades (CVE), licencias o versiones de dependencias |
| `security-scan` | Al pedir SAST, detección de secretos o hardening de seguridad |
| `spring-boot-architecture` | Al crear, revisar o modificar un servicio Spring Boot |
| `java-build-quality` | Al verificar un proyecto Java o pedir cobertura/análisis estático (comandos exactos Maven/Gradle, rutas de informes, qué hacer si falta una herramienta) |

Todas las skills deben tener frontmatter válido (`---` de apertura y
cierre, `name` igual al directorio y `description` no vacía): sin él
OpenCode no carga la skill. `verify-factory.sh` lo comprueba sobre las 10
locales y la de terceros (11 en total).

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
   real y reporta defectos demostrables sin modificar nada.
6. Si implementador y revisor discrepan, o un fallo persiste tras varios
   intentos, `build` puede convocar a `cloud-arbiter`.
7. Solo entonces se da la tarea por terminada, con la evidencia de los
   pasos 4 y 5 en el informe.

### Calidad Java

Estrategia **CLI-first**: toda la calidad se ejecuta con herramientas de
línea de comandos locales, sin servidor, sin contenedores y sin credenciales
en el repositorio. La skill `java-build-quality` y el comando
`/calidad-java` son la referencia operativa.

#### Plantillas de calidad (`templates/quality/`)

Dos fragmentos con los plugins ya configurados y con versiones fijadas:

| Fichero | Ecosistema | Plugins que aporta |
| --- | --- | --- |
| `maven-quality-plugins.xml` | Maven (`pom.xml`, bloques `<plugin>` para `<build><plugins>`) | checkstyle 3.6.0, PMD 3.28.0, SpotBugs 4.10.5.0, JaCoCo 0.8.15 |
| `gradle-quality.gradle` | Gradle con Groovy DSL (`build.gradle`, requiere el plugin `java`) | checkstyle 12.3.1, PMD 7.28.0, JaCoCo 0.8.15. **SpotBugs no se incluye**: en Gradle requiere el plugin del Portal (`com.github.spotbugs`), se informa pero no se inyecta para no romper la build |

Las versiones de la plantilla Gradle están fijadas para el **JDK 17**
(Temurin 17.0.20, el `java` del PATH) con Gradle 8.14.5: Checkstyle
12.3.1 es la última versión cuyo POM declara `<java.version>17</java.version>`
en Maven Central; las líneas 13.x/14.x exigen Java 21 y, como la plantilla
no declara *toolchain*, la herramienta se ejecuta con el JVM de Gradle y la
build falla en un entorno con Java 17. Si usas Java 21, puedes subir
`toolVersion` a `14.3.0` sin más cambios.

Qué configuran:

- **Checkstyle** con reglas inline (sin ficheros externos): tabuladores y
  espacios al final de línea rompen el build; longitud de línea 120 como
  *warning*; `UnusedImports`, `RedundantImport`, `NeedBraces`,
  `EmptyStatement`, `EqualsHashCode`, `ArrayTypeStyle`, `UpperEll` y
  `ModifierOrder`. En Maven se liga a la fase `verify` con
  `failOnViolation` y `maxAllowedViolations=0`; en Gradle con
  `maxErrors` 0.
- **PMD**: en Maven `failurePriority=2` (prioridades 1-2 rompen el build,
  3-5 quedan como aviso en `target/pmd.xml`); en Gradle usa el ruleset por
  defecto y cualquier violación rompe el build (para solo informar,
  `ignoreFailures = true`).
- **SpotBugs** (solo Maven): `effort=Max`, `failThreshold=High`, informe
  XML.
- **JaCoCo**: `prepare-agent` + `report` + `check` con umbral de cobertura
  de líneas `COVEREDRATIO >= 0.50` sobre el paquete (`BUNDLE`). En Gradle,
  `check` pasa a depender de `jacocoTestReport` y
  `jacocoTestCoverageVerification`. Si tu `maven-surefire-plugin` declara
  un `<argLine>` propio, incluye `${argLine}` dentro para que JaCoCo pueda
  inyectar su agente.

#### Inyección: `factory.py quality [--apply]`

```bash
python3 scripts/factory.py quality <proyecto>           # informe, no toca nada
python3 scripts/factory.py quality <proyecto> --apply   # respalda e inyecta
```

Comportamiento:

- Detecta el build: `pom.xml` → Maven, `build.gradle` → Gradle Groovy,
  `build.gradle.kts` → informa y no toca nada (la plantilla es Groovy). Si
  conviven varios, el build es **ambiguo**: solo informa.
- **Sin `--apply` nunca escribe**: imprime `PRESENTE`/`FALTA` por plugin y
  el comando de ejecución, y devuelve `0` si todo lo gestionable está
  presente o `2` si falta algo.
- **Con `--apply`** solo inyecta los plugins que falten (no duplica los
  presentes), tras crear un respaldo del fichero de build en
  `~/.local/state/opencode-software-factory/quality/` (misma ruta
  ajustable con `OPENCODE_SOFTWARE_FACTORY_STATE` o `XDG_STATE_HOME`).
  Antes de escribir valida que el resultado siga siendo correcto (XML bien
  formado y plugins detectados); si no puede inyectar con seguridad, no
  modifica nada y devuelve `2`.
- **Idempotente**: una segunda pasada con `--apply` no cambia el fichero.
- **Se rechazan sin tocar nada** (código `2`): un `<build>` con `<plugins/>`
  auto-cerrado (habría que crear un segundo `<plugins>`), un `<build>` sin
  `</build>`, un primer `<build>` dentro de `<profiles>` o un `<profiles>` que
  precede al `<build>` (posición ambigua).
- **Detección Maven**: solo cuenta lo activo en `<build><plugins>`; un plugin
  declarado únicamente en `<pluginManagement>`, en un `<profiles>` (que puede
  estar inactivo), en `<reporting>` o solo como `<dependency>` (del proyecto o
  de otro plugin) se reporta FALTA y se inyecta en
  `<build><plugins>`, dejando esos bloques intactos. Si el `<build>` ya tiene
  su `<plugins>` (aunque esté antes de `<pluginManagement>`), se usa ese y no
  se crea otro: el XSD de Maven admite como máximo un `<plugins>` en `<build>`.
- **Qué significa `PRESENTE`**: el `<artifactId>` del plugin aparece declarado
  en el `<build>` del pom (en la práctica, dentro de su `<plugins>`: los
  comentarios y los bloques `<pluginManagement>`, `<profiles>`, `<reporting>`,
  `<dependencies>` y `<dependencyManagement>` se enmascaran antes de buscar, de
  modo que **un plugin citado solo como `<dependency>` no cuenta**). `PRESENTE`
  **no** implica que esté ligado al ciclo `verify`: un plugin declarado sin un
  `<execution>` que se ejecute en esa fase se reporta PRESENTE pero
  `mvn verify` no lo ejecuta. Revísalo a mano si dependes de eso.
- **Alcance Gradle (limitación conocida)**: el análisis mira solo el
  `build.gradle` de la raíz. Un plugin declarado únicamente en un submódulo
  se reporta FALTA aunque otro módulo lo aplique, y uno declarado en el
  `plugins {}` del raíz con `apply false` se reporta PRESENTE aunque no se
  aplique ahí. No se resuelve en la fábrica: aplícalo a mano en los módulos
  que corresponda.
- Si el fichero de build no está en UTF-8 no se analiza ni se modifica y
  devuelve `2`.
- Si el proyecto no tiene ninguno de los tres ficheros de build, devuelve
  `1`.
- Ante cualquier duda, el mensaje invita a pegar los bloques a mano desde
  `templates/quality/` (cada plantilla indica en su cabecera los comandos y
  los informes que genera).

#### Comandos de ejecución por ecosistema

Usa el wrapper del proyecto si existe (`./mvnw` / `./gradlew`); si no, el
`mvn`/`gradle` del sistema y dilo en el informe. `-B` = Maven no
interactivo.

| Propósito | Maven | Gradle |
| --- | --- | --- |
| Tests unitarios | `mvn -B test` | `./gradlew test` |
| Batería completa (tests + análisis ligados a `verify`/`check`) | `mvn -B verify` (tests + checkstyle + pmd + spotbugs + jacoco) | `./gradlew build` y `./gradlew check` (tests + checkstyle + pmd + jacoco) |
| Estilo | `mvn -B checkstyle:check` | `./gradlew checkstyleMain` |
| Estática (reglas) | `mvn -B pmd:check` | `./gradlew pmdMain` |
| Estática (bugs) | `mvn -B spotbugs:check` | `./gradlew spotbugsMain` (requiere el plugin del Portal declarado) |
| Cobertura (informe) | `mvn -B jacoco:report` | `./gradlew jacocoTestReport` |
| Auditoría OWASP de dependencias | `mvn org.owasp:dependency-check-maven:check` | `./gradlew dependencyCheckAnalyze` |
| Árbol de dependencias | `mvn dependency:tree` | `./gradlew dependencies` |
| SAST / secretos (si están instalados) | `semgrep --config auto .`, `bandit -r .`, `truffleHog .`, `detect-secrets scan` | ídem |

#### Dónde quedan los informes

| Herramienta | Maven | Gradle |
| --- | --- | --- |
| Cobertura HTML | `target/site/jacoco/index.html` | `build/reports/jacoco/test/html/index.html` |
| Cobertura XML | `target/site/jacoco/jacoco.xml` | `build/reports/jacoco/test/jacocoTestReport.xml` |
| Checkstyle | `target/checkstyle-result.xml` | `build/reports/checkstyle/main.html` |
| SpotBugs | `target/spotbugsXml.xml` | `build/reports/spotbugs/main.html` |
| PMD | `target/pmd.xml` | `build/reports/pmd/main.html` |
| OWASP dependency-check | `target/dependency-check-report.html` | `build/reports/dependency-check/` |
| Tests (JUnit XML/HTML) | `target/surefire-reports/` | `build/reports/tests/test/` |

Los informes solo existen tras ejecutar la herramienta correspondiente:
**nunca cites un informe que no se haya generado**.

#### Qué hay disponible en esta máquina

| Herramienta | Estado |
| --- | --- |
| Maven 3.9.16, Gradle 8.14.5, JDK 17 (además 21 y 25) | instalados |
| Plugins de calidad (checkstyle, PMD, SpotBugs, JaCoCo, OWASP) | la fábrica **no** los instala: el build los declara y Maven/Gradle los descargan a `~/.m2` o `~/.gradle` en la primera ejecución |
| Docker | no instalado → sin Testcontainers |
| `semgrep`, `bandit`, `sonar-scanner`, `codeql`, `truffleHog`, `detect-secrets` | no instalados (`command -v <herramienta>` no los encuentra) |

Si el proyecto no declara una herramienta, el resultado es
`Task ... not found` o `No plugin found for prefix`. En ese caso la skill
`java-build-quality` obliga a **reportar "no disponible" y proponer añadir
el plugin con versión fijada**; si se prueba igualmente por descriptor, se
informa el código de salida real y se deja claro que es una ejecución sin
configuración del proyecto (reglas por defecto). Nunca se simula un
resultado ni se inventa un porcentaje de cobertura.

### Permisos de los agentes

Los permisos van en el frontmatter de cada agente y se evalúan por orden,
con la regla de OpenCode **"last matching rule wins"** (gana la **última**
regla que coincide) y resultado `ask` si ninguna coincide; cuando una
operación toca varios recursos (por ejemplo un comando compuesto), basta un
`deny` para bloquearla. Referencia:
https://opencode.ai/v2/docs/permissions/

- **`architect` y `reviewer` (solo lectura)**: `edit * → deny` y
  `shell * → deny` globales, con una lista explícita de reglas `allow` de
  inspección colocadas **después** de los `deny` (para que ganen por
  "last match"): lectura de git (`status`, `log`, `diff`, `show`),
  inspección de ficheros (`ls`, `cat`, `grep`, `head`, `tail`, `sed -n`,
  `wc`, `sort`, `uniq`, `cut`, `stat`, `diff`, `du`, `file`, `which`,
  `echo`, `pwd`), pruebas (`pytest`, `unittest`, `./gradlew test`,
  `./mvnw test`, `mvn test` y variantes `-B`), comandos de versión
  (`java -version`, `mvn -version`, `gradle --version`) y las
  verificaciones de la fábrica (`bash scripts/verify-factory.sh`,
  `python3 scripts/factory.py self-test`, `python3 -m py_compile *`,
  `jq -e *`). No hay regla para `find` (usa las herramientas `glob` y
  `grep`) ni para `bash` genérico ni para la batería Java: el revisor se
  apoya en los informes y códigos que produce `tester`.
- **`reviewer` (además de lo anterior)**: puede inspeccionar un build sin
  modificarlo con `python3 scripts/factory.py quality *` (solo informe) y
  `python3 scripts/factory.py install --help` / `install * --dry-run`; el
  `deny python3 scripts/factory.py quality *--apply*` va **después** del
  allow, así que `quality --apply` (en cualquier posición del flag) queda
  bloqueado para quien no debe modificar nada.
- **`tester`**: `shell * → ask` por defecto y `edit * → deny`; la lista
  `allow` habilita **sin aprobación** la inspección (git de lectura,
  `bash scripts/verify-factory.sh`,
  `python3 scripts/factory.py self-test|status|doctor`), la batería
  Maven/Gradle (wrappers y del sistema, incluidos checkstyle, pmd,
  spotbugs, jacoco, OWASP y `dependency:*`), Python
  (`pytest`, `unittest`, `compileall`, `ruff`), Node/TypeScript (`npm`,
  `tsc`, `eslint`, `node --test`), `make test|build`, `bash`/`sh`,
  auditorías de dependencias y SAST/secretos cuando estén instalados.
- **Denegados en `tester`** (y por tanto excluidos): `sudo`, `rm`,
  `rm -rf`, `git push`, `git commit`, `git checkout`, `git reset`,
  `git restore`, `curl`, `wget`, `bash -c`, `sh -c`, cualquier comando cuyo
  texto contenga `>` (reglas `deny` `*>` y `*>*`, que también cubren
  `2>&1` y un `>` dentro de un argumento), cualquier acceso a `*.env*` y
  toda edición de archivos.
- `find` no está permitido por shell en ningún agente: `-delete` y `-exec`
  permitirían mutar el árbol de ficheros desde agentes de solo lectura.
  Para localizar ficheros usa `glob` y `grep`.
- En `architect` y `reviewer` las redirecciones quedan denegadas: si una
  tarea legítima necesita redirigir, repórtalo en vez de ejecutarlo.
- Las reglas `*.env*` → `deny` son las últimas reglas `shell` de
  `architect`, `reviewer` y `tester`: cubren `grep`, `sed`, `ls`, etc.
  sobre `.env`, no solo `cat`/`head`/`tail`.
- `./gradlew bootRun` no tiene ninguna regla específica: en `tester`
  resuelve en `ask` y en `architect`/`reviewer` cae en su `shell * → deny`.
  En ningún caso arranca el servidor sin aprobación.
- La lista de permitidos sin aprobación de `tester` es la que habilita la
  batería de [Calidad Java](#calidad-java); la ausencia de una herramienta
  en el PATH se informa como "no disponible", nunca como ejecutada.

#### Ejecuciones no interactivas (`ask` y `--auto`)

En un cliente **no interactivo** (`opencode run`, CI) un permiso que
resuelve en `ask` no tiene quién lo apruebe y la operación se
**auto-rechaza**. Por eso las reglas de inspección y de build de los agentes van como `allow`
explícitas **después** de los `deny` globales (para que ganen por "last
match"), y los `deny` de secretos, redirecciones y comandos peligrosos
quedan al final. En ejecuciones **interactivas** el TUI pregunta en lugar
de rechazar, y existe el flag global `--auto`
(`opencode run --auto ...`), que aprueba lo que no esté denegado (los
`deny` siguen aplicándose).

### Verificación y troubleshooting

| Comando | Propósito | Código esperado |
| --- | --- | --- |
| `jq -e . opencode.json` | JSON de la fábrica bien formado | `0` |
| `python3 -m py_compile scripts/factory.py` | Sintaxis del instalador | `0` |
| `python3 scripts/factory.py self-test` | Instalación/preservación/reversión/inyección `quality` en directorios temporales | `0`, salida `SELF-TEST COMPLETADO` |
| `bash scripts/verify-factory.sh` | Batería estructural completa (config, modelo, newline, plantilla y fragmentos de calidad, agentes, skills y su frontmatter, config y agentes efectivos de OpenCode, self-test) | `0` y 12 líneas `PASS` |
| `python3 scripts/factory.py status <proyecto>` | Estado de los archivos instalados | `0` sin cambios, `2` con cambios |
| `python3 scripts/factory.py doctor <proyecto>` | Comprobación funcional en el proyecto consumidor | `0` todo PASS, `2` hallazgos, `1` error técnico |
| `python3 scripts/factory.py quality <proyecto> [--apply]` | Plugins de calidad del build | `0` completo, `1` error, `2` falta algo o build ambiguo |
| `opencode debug config` / `opencode debug agents` | Configuración y agentes que OpenCode carga realmente | `0` con salida JSON |

`verify-factory.sh` es una comprobación **estructural**: no sustituye las
pruebas del proyecto consumidor ni demuestra por sí sola que las respuestas
de los agentes sean correctas.

**`opencode debug agents` puede tardar en directorios recién instalados**:
el servicio de OpenCode tarda en cargar la configuración de una ubicación
nueva, y la primera invocación puede devolver `[]` o solo los agentes
globales (por ejemplo `build` con modelo `None`), lo que produciría falsos
negativos en `doctor`. Por eso `doctor` reintenta **hasta 5 veces con 2 s
de espera** hasta que aparezcan los 7 agentes esperados, informando cada
espera con una línea `NOTA: ... (intento N/5); se reintenta en 2 s.`; solo
tras agotar los intentos informa los hallazgos con la respuesta disponible.

**Re-ejecutar `status`/`doctor` tras modificar archivos**:

- `status` → `2` y línea `MODIFICADO (se conservará)`: el archivo se editó
  respecto al manifiesto; `uninstall` lo conservará y actualizará el
  registro. Es el estado esperado tras personalizar un agente o comando.
- `doctor` valida el *frontmatter* de los agentes (id, modo, proveedor,
  modelo) y la configuración que OpenCode carga: si cambias `mode:` o
  `model:` en un agente, `doctor` → `2`.
- Si el manifiesto desaparece, `status` informa `Sin instalación registrada`
  → `0`, y `install` vuelve a estar disponible.

## Modelo de referencia

`opencode-go/mimo-v2.6-flash` (MiMo V2.6 Flash, servido por el proveedor
integrado OpenCode Go). Es el modelo fijado en `opencode.json` y en los
siete agentes. El proveedor integrado `opencode-go` no necesita entrada en
el bloque `providers` de `opencode.json`: el formato
`opencode-go/<model-id>` en la clave `model` basta porque OpenCode ya
integra el proveedor. El bloque `providers` versiona únicamente
proveedores locales opcionales (`zen-proxy` y `lmstudio`) que no afectan
al modelo por defecto.

Requisitos:

- Plan OpenCode Go activo, con un límite de uso de aproximadamente
  **60 $/mes** propio del plan Go.
- Conexión del workspace mediante `/connect` → **OpenCode Go**
  (autenticación con la cuenta de OpenCode).

### Cambio a otro proveedor (OpenRouter)

Para usar OpenRouter en lugar del proveedor integrado, `opencode.json`
adopta esta forma:

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

Sin `limit.output` ni `options.max_tokens`, OpenCode pide el valor por
defecto de **131072** tokens de salida, muy por encima del límite de 3500
configurado en el bloque anterior.
Además hay que fijar `openrouter/xiaomi/mimo-v2.6-flash` en el frontmatter
`model:` de los siete agentes de `.opencode/agents/`.

## MCP y configuración global

Servidores MCP declarados en el `opencode.json` de la fábrica. Por decisión
explícita de centralización (octubre de 2026) se versionan en este
repositorio y `install` los lleva a los proyectos consumidores junto con
el resto de la configuración:

| MCP | Uso |
| --- | --- |
| `context7` | documentación de librerías y frameworks |
| `playwright` | navegación y pruebas de navegador |
| `rea` | acompaña a la skill de terceros `reverse-engineer-anything` |

Los tres se obtienen con
`jq -r '.mcp.servers | keys[]' opencode.json`. Solo declaran rutas locales
y comandos de arranque (binarios, `npx`, URL remota): no contienen
credenciales ni tokens.

**SonarQube no se usa**: requiere servidor propio o cuenta SonarCloud con
token, `sonar-scanner` no está instalado y tampoco hay Docker para
levantarlo. Mientras tanto, la estrategia es la CLI-first descrita en
[Calidad Java](#calidad-java). Si algún día se adopta, la configuración del
escáner, la URL del servidor y el **token van en la configuración global
del usuario** o en variables de entorno.

**Regla general**: los MCP (`rea`, `context7`, `playwright`) viven en el
`opencode.json` versionado de la fábrica por centralización explícita, y
por eso se instalan en los proyectos consumidores. Ese fichero solo puede
contener configuración no sensible (rutas locales, comandos, URLs públicas,
permisos y proveedores), **nunca credenciales, tokens ni secretos reales**: las credenciales, los tokens y cualquier
secreto siguen viviendo en la configuración global del usuario o en
variables de entorno, **nunca en el `opencode.json` de la fábrica** ni en
ningún fichero versionado del repositorio.

## Principios de calidad

- No afirmar que una prueba pasó si no se ejecutó y se observó su salida.
- No inventar archivos, herramientas, resultados ni fuentes.
- Revisar los cambios mediante Git.
- Proteger operaciones destructivas y despliegues mediante aprobación.
- Separar hallazgos comprobados de hipótesis.

## Separación entre fábrica y proyectos consumidores

La fuente mantenible de los agentes, skills, comandos, scripts y
documentación debe permanecer en este repositorio:
`opencode-software-factory`. Los proyectos consumidores son destinos de
instalación y prueba, no el lugar donde se deben desarrollar o documentar
las mejoras generales de la fábrica.

Antes de instalar o sincronizar cambios en un consumidor, se debe revisar
el estado del destino y preservar sus archivos propios, su configuración
`opencode.json` y cualquier modificación ajena. No se deben eliminar
archivos sin verificar su procedencia y obtener autorización cuando exista
duda.

## Limitaciones conocidas

- **Sin Docker**: no se pueden ejecutar pruebas con Testcontainers ni
  contenedores (`docker --version` → 127).
- **Sin herramientas SAST/secretos instaladas**: `semgrep`, `bandit`,
  `sonar-scanner`, `codeql`, `truffleHog` y `detect-secrets` no están en el
  PATH; se informan como "no disponibles".
- **Sin SonarQube**: ver [MCP y configuración global](#mcp-y-configuración-global).
- **SpotBugs en Gradle** no se inyecta: requiere el plugin del Portal
  (`com.github.spotbugs`), que hay que declarar a mano.
- **`build.gradle.kts` no lo gestiona `quality`**: la plantilla es Groovy;
  hay que pegar los bloques a mano.
- **La auditoría OWASP** necesita que el proyecto declare el plugin; la
  primera ejecución descarga la base NVD (requiere red y varios minutos).
- Los permisos sin aprobación están pensados para Java, Python,
  Node/TypeScript y `make`; otros stacks quedan en `ask`.

# Factory Control Center

Interfaz local de operación de OpenCode Software Factory. Coordina agentes de OpenCode y Claude Code, conserva el historial en SQLite y exige una preconsulta y decisiones humanas antes de iniciar una tarea nueva.

## Requisitos

- Linux con Node.js 24 o superior.
- OpenCode CLI instalado y autenticado/configurado.
- Claude Code CLI instalado para habilitar su motor.
- Python 3, jq y las herramientas del repositorio para la verificación integral.
- Las credenciales permanecen en las instalaciones locales de cada herramienta; no se almacenan en el repositorio ni en el manifiesto del equipo.
- La línea base de seguridad, incluida la excepción temporal de picomatch, está registrada en docs/SECURITY-BASELINE.md.

## Arranque habitual (servicio instalado)

~~~bash
systemctl --user start factory-control-center.service
systemctl --user status factory-control-center.service --no-pager
curl -fsS http://127.0.0.1:4141/api/health | jq
~~~

Abre http://127.0.0.1:4141/. No inicies dev o start con el servicio activo;
comparten el puerto 4141. Para detener o reiniciar, comprueba antes que no
haya rondas activas. Consulta el [inicio rápido](../README.md#inicio-rápido).

## Desarrollo local

Desde este directorio:

~~~bash
npm ci
npm run dev
~~~

Abrir http://127.0.0.1:5173. Vite sirve la interfaz y redirige /api a Fastify en http://127.0.0.1:4141.

La API se enlaza exclusivamente a 127.0.0.1; no se publica en interfaces de red externas.

## Flujo de trabajo

Una ejecución inicial debe pasar por el flujo completo del servidor:

1. **Preconsulta del proyecto:** analiza estructura, stack, manifiestos, instrucciones y contexto Git en modo de solo lectura.
2. **Propuesta automática o configuración manual:** recomienda agentes y modelos exclusivamente entre los favoritos vigentes.
3. **Decisión explícita:** el usuario acepta la propuesta o selecciona la configuración manual.
4. **Guardar el equipo:** el servidor exige una instantánea guardada de las asignaciones.
5. **Iniciar instrucciones:** el backend vuelve a validar la ruta y consume la preconsulta de forma atómica y de un solo uso.

La interfaz no es la frontera de seguridad: la API vuelve a comprobar estos requisitos aunque se invoque directamente.

Las continuaciones de un proceso de trabajo conservan el objetivo original, el historial conversacional, las configuraciones históricas, las decisiones y los handoffs de rondas anteriores.

## Instrucciones extensas mediante archivos TXT

El campo **Tu primera instrucción** y el chat de **¿Qué hacemos a continuación?**
permiten adjuntar un archivo `.txt` guardado en UTF-8, sin necesidad de pegar
su contenido en el formulario. El texto del chat continúa admitiendo 24.000
caracteres **independientemente** de la capacidad del archivo.

- Cada TXT puede ocupar hasta **128 KiB (131.072 bytes) UTF-8**; el sistema
  acepta el documento completo o rechaza la solicitud explicando el límite.
  No se recorta silenciosamente su contenido.
- Se admite **un TXT activo por ronda**, junto con texto opcional escrito en
  el chat. El selector permite subir uno nuevo o **reutilizar** un TXT de
  una ronda anterior del mismo proceso. Hasta ocho archivos guardados por
  proceso, con botón para descargar el original.
- La fábrica guarda el contenido íntegro en **SQLite privado**, con nombre,
  ronda de procedencia, tamaño y huella SHA-256. No copia el TXT al proyecto
  de programación ni lo añade por accidente a sus commits.
- El contenido íntegro del archivo elegido se incorpora a las instrucciones
  de **cada agente que participe en esa ronda**, tanto en OpenCode como en
  Claude Code, y también participa en la clasificación de la tarea. Los
  archivos anteriores permanecen almacenados, pero **no se vuelven a
  ejecutar automáticamente**: hay que seleccionarlos expresamente.
- Si una lectura fuera a superar la ventana de contexto de un modelo,
  el motor podría no procesarla en una sola interacción; un archivo más
  corto o varias rondas reduce ese riesgo. Conservar cada byte en SQLite
  e incluirlo en el prompt **no garantiza la comprensión del modelo**.
- No adjuntes contraseñas, credenciales ni datos ajenos al propósito del
  trabajo: los archivos se guardan como texto local y los modelos reciben
  su contenido cuando se seleccionan.

## Ejecución y permisos

- Cada agente tiene motor, modelo favorito y perfil de permisos independiente.
- En **Modelos favoritos**, el selector de OpenCode ahora distingue el
  **Proveedor / conector**: elige **OpenCode Go** para ver sus modelos
  separados del catálogo de NVIDIA, LM Studio y otros proveedores.
  Los IDs de OpenCode mantienen el prefijo `opencode-go/`; Claude Code,
  conectado al mismo proveedor, utiliza IDs sin dicho prefijo.
  Los favoritos y asignaciones se mantienen guardados por separado.

- Los perfiles disponibles son read-only, workspace-write y approval-required.
- Los agentes de solo lectura usan el MCP local de archivos para consultar el proyecto; no reciben shell ni herramientas nativas de escritura.
- Los accesos a rutas sensibles, credenciales, metadatos Git y rutas fuera del proyecto se bloquean en las capas de permisos y del MCP.
- Las aprobaciones OpenCode reutilizables se limitan al identificador de ejecución del agente y a los recursos concretos de la solicitud. Las sugerencias amplias save del proveedor no se aceptan como frontera de autorización.
- Las decisiones humanas pasan por los estados pending → responding → approved/rejected/answered. La reserva SQLite es atómica para impedir doble respuesta. Si el estado externo del motor no puede reconciliarse, la decisión queda huérfana y requiere revisión; no se vuelve a aprobar automáticamente.
- Los informes de handoff se validan mediante ID, SHA-256, longitudes UTF-8, identidad del emisor y truncamiento. Los secretos conocidos se redactan antes de persistir los handoffs.

## Agente del sistema: Auditor de permisos (v1)

**Activo automáticamente durante cada ronda**. No es un modelo de lenguaje
adicional que pueda inventar autorizaciones, sino un motor de políticas
deterministas integrado en el orquestador. Supervisa las solicitudes tanto de
OpenCode como de Claude Code y registra sus decisiones en los eventos
`AUDITOR` de SQLite y en el Centro de decisiones.

- **Autoaprobación de bajo riesgo:** consultas Git de solo lectura
  con argumentos expresamente permitidos (por ejemplo, `git status --porcelain=v1 -uall`,
  `git rev-parse --abbrev-ref HEAD`, `git diff --stat` y
  `git show --stat <hash>`),
  `npm run check`, `npm run test:unit`, `npm run smoke` (incluida la
  visualización limitada `2>&1 | tail -20; echo "SMOKE_EXIT=${PIPESTATUS[0]}"`),
  y algunas
  acciones de navegador local (navegar a inicio/salud, redimensionar,
  consola, capturas confinadas). Cada permiso se concede **una sola vez**,
  con el perfil `workspace-write` y durante la ronda activa.
- **Gradle:** desde la raíz canónica del proyecto, wrapper regular sin symlink,
  tareas test/build/check o tests de módulos, con flags explícitos
  (--console=plain, --rerun-tasks, --offline, --no-daemon) y formato
  acotado de salida que conserva EXIT_CODE. Igual que npm, ejecuta código
  del proyecto; solo utilizar workspaces confiables. No autoriza publish,
  bootRun, init scripts, opciones arbitrarias ni rutas externas.
- **Resultados JUnit:** ambos motores pueden usar la herramienta de solo
  lectura summarize_junit del MCP factory_filesystem, con módulos
  relativos explícitos. Resume contadores de los XML convencionales sin
  shell, sin ejecutar código ni mostrar logs. No demuestra por sí sola
  que los informes sean recientes. Python y JShell arbitrarios requieren
  revisión puntual.
- **Decisión humana:** operaciones desconocidas, respuestas a formularios,
  navegación web externa, `browser_evaluate`, clics arbitrarios,
  instalación de dependencias, modificaciones Git (commit, push) o
  comandos que no pasan la lista explícita. Nunca se usan los globs
  `save: ["*"]` como concesión.
- **Alerta crítica:** `pkill`, `kill`, `killall`, `fuser`,
  borrados, reinicio/parada de servicios, comandos destructivos y
  `git reset --hard` requieren una **confirmación humana puntual**
  y no pueden recibir permiso reutilizable de la fábrica.
  En el panel se muestran con aviso de riesgo elevado.
- **Auditoría final de evidencias:** examina los recibos nativos de shell
  persistidos y añade hallazgos de alto riesgo al resumen ejecutivo,
  incluso cuando los otros agentes declaren éxito. El estado de una
  prueba no prueba por sí mismo la seguridad del proceso.
- **Autorreparación:** DESACTIVADA, sin cambios autónomos en el código de
  la fábrica. Una eventual función de reparación requerirá diseño,
  pruebas, reversión y consentimiento explícito en una ronda futura.

**Límites de seguridad:** no es una sandbox del sistema operativo. Un
script de prueba del propio repositorio puede ejecutar operaciones
indirectas; por ello los proyectos y sus scripts deben ser confiables.
Las instrucciones y las pruebas deben usar puertos y datos temporales
aislados. Un agente no debe cerrar procesos según el nombre genérico
`node server.js` ni matar el PID que simplemente escucha el puerto
del proyecto: ese proceso puede pertenecer a un servicio persistente.

## Persistencia y privacidad

El historial de ejecuciones, eventos, decisiones, aprobaciones, handoffs y procesos de trabajo se guarda en SQLite en:

~~~text
~/.local/state/opencode-software-factory/control-center/control-center.sqlite
~~~

El directorio raíz de estado y control-center usan permisos 0700; la base SQLite y sus archivos auxiliares usan 0600. El ledger de aprobaciones se conserva completo, aunque la interfaz limite la ventana visible de eventos.

No guardar API keys, tokens ni credenciales en este repositorio. No se modifican las configuraciones globales de OpenCode ni Claude Code.

## Verificación integral

Antes de considerar listo un cambio, ejecuta:

~~~bash
npm run verify
~~~

La puerta de verificación ejecuta:

- Suite de API, preconsulta, permisos, concurrencia, persistencia y recuperación.
- Pruebas del MCP de archivos y de fingerprint del build.
- Typecheck de API y frontend.
- Auditoría npm de producción y del árbol completo, con excepción precisa y temporal solo para el advisory upstream conocido.
- Pruebas contra solicitudes cross-site y cabeceras de seguridad.
- Compilación sintáctica de los scripts Python.
- Pruebas del verificador de agentes contra enlaces simbólicos.
- Verificación real del registro de OpenCode y sus siete agentes, sin realizar llamadas a modelos.
- Self-test del instalador, incluyendo conflictos, reversión y protecciones de rutas.

La verificación del registro requiere que OpenCode CLI esté instalado. No invoca modelos ni inicia trabajo del usuario.

## Build y despliegue local

Para compilar sin reiniciar:

~~~bash
npm run build
~~~

El build genera dist-api/api/build-info.json con una huella SHA-256 determinista del código, instrucciones, agentes, skills, MCP y configuración que forman parte del runtime.

Para desplegar en el servicio systemd del usuario:

~~~bash
npm run deploy
~~~

El comando:

1. Ejecuta npm run verify y se detiene si algo falla.
2. Compila API y frontend y genera el fingerprint.
3. Reinicia factory-control-center.service.
4. Espera la API y compara el fingerprint cargado en memoria con el artefacto que existe en disco.
5. Solo informa éxito si el servicio está ejecutando exactamente el build compilado.

El endpoint GET /api/health expone runtimeBuildId, artifactBuildId, runtimeMatchesDisk y el estado de verificación. En producción, un build ausente o distinto degrada el estado de salud y la interfaz muestra una advertencia. Así, compilar sin reiniciar ya no pasa inadvertido.

Comprobación manual:

~~~bash
curl -sS http://127.0.0.1:4141/api/health | jq
systemctl --user status factory-control-center.service
journalctl --user -u factory-control-center.service -n 100 --no-pager
~~~

## Pruebas de ejecución multiagente

La suite automatizada valida los componentes y sus límites, pero no sustituye una ejecución real con proveedores. Una ronda multiagente consume los modelos configurados y puede requerir decisiones humanas; debe iniciarse como una prueba operativa separada y auditarse hasta el informe del Cloud Arbiter.

## Límites conocidos que deben seguir siendo visibles

- El JDK del sistema debe estar en el PATH para que ./run-tests.sh funcione sin ajustes. La presencia de un JDK dentro de un IDE no equivale a tenerlo disponible en el entorno del servicio.
- La colaboración entre motores solo se considera plenamente verificada cuando existen handoffs de ambas direcciones con identidad, contenido y recepción acreditados; una entrega cuyo ID añade el orquestador no acredita por sí sola la identidad original.
- Los agentes y herramientas externas pueden tener límites propios de disponibilidad, cuotas o capacidades. La fábrica debe reportar lo que no pudo ejecutar como no verificado, nunca como aprobado.

### Consolidación de rondas y continuidad

Todas las rondas entregan una respuesta con el contenido real de los
informes disponibles, incluso si no se selecciona el Árbitro técnico. El
orquestador extrae conclusiones, hallazgos, verificaciones y recomendaciones
con atribución al especialista; si faltan secciones, muestra un extracto
del informe. No confunde una fase técnicamente finalizada con una
implementación efectuada. Los informes completos y el registro de seguridad
permanecen disponibles. Al iniciar, se recuperan de forma idempotente los
resúmenes históricos que solo mostraban métricas y conservan informes válidos.
El planificador reconoce requisitos de salida expresados como un resultado
deseado (por ejemplo, que los campos de un endpoint devuelvan cadenas vacías),
sin exigir la palabra «implementar»; las preguntas y revisiones explícitas
no se convierten por ello en permisos de escritura.

### Ajustes de seguridad y trazabilidad tras la auditoría de la ronda 3

- Las cadenas de inspección Git pueden terminar un segmento reconocido con
  `| head -N` o `| head -n N` (1–100 líneas, sin archivos de entrada ni
  redirecciones). La consulta `git remote -v` se permite en OpenCode solo si el comando
  nativo coincide, la raíz es la asignada y las URLs no contienen
  credenciales; se admite el identificador público repetido de Azure DevOps. El perfil y las demás
  restricciones del Auditor siguen vigentes.
- Claude no puede solicitar `dangerouslyDisableSandbox` como excepción:
  el hook PreToolUse y la devolución de permisos rechazan esa solicitud,
  incluso si el comando figura en la lista segura. Debe repetirlo sin esa opción.
  Esto no equivale a certificar un aislamiento completo de todos los procesos.
- Si una respuesta final de OpenCode contiene progreso seguido de un separador
  explícito y un informe con el ID exacto, agente, motor, ejecución y registro
  correspondientes, el orquestador separa el preámbulo (conservado en eventos)
  y calcula la integridad del informe seleccionado. Los casos ambiguos
  conservan la observación de identidad; no se reescribe el historial.
- `search_text` acepta un archivo regular o un directorio relativo al
  proyecto; mantiene límites de bytes, coincidencias, rutas y symlinks.
  No busca en dependencias ni artefactos excluidos; para JUnit se utiliza
  `summarize_junit`.
- El diagnóstico exacto `unrecognized_model` con
  `query_source=generate_session_title` se muestra como información, sin
  ocultar el texto del SDK. Los errores de inferencia, autenticación,
  cuotas y diagnósticos desconocidos no se reclasifican.

### Autorización Git vinculada a la instrucción de la ronda

El Auditor permite al Implementador de OpenCode preparar archivos específicos,
crear commits normales y publicar la rama actual cuando el usuario lo pide
directamente en la instrucción de esa ronda (por ejemplo, «hagamos commit y
push»). No se deduce autorización del planificador, del historial, de los
informes de agentes ni de los patrones propuestos por el proveedor.
Cada mutación se verifica por separado: comando nativo asociado al mensaje y
llamada exactos, directorio raíz canónico, archivos regulares no sensibles,
índice para commit y upstream de la rama actual en origin para push.
No se autoriza automáticamente git add global, amend, force, mirror, refspecs
arbitrarios, cambios de remoto, symlinks o scripts de shell. El mensaje de
commit admite texto literal y el heredoc EOF citado exacto, no cat arbitrario.
Las consultas de estado, resumen del commit y referencias origin admiten
los formatos acotados observados, incluyendo nombres de rama con #.
Las URLs con usuario o contraseña se redactan en los nuevos registros.
Las inspecciones y operaciones Git siguen sujetas a los perfiles existentes;
las verificaciones no constituyen un escáner exhaustivo de secretos ni un
sandbox para hooks, filtros o credenciales Git. Si falta evidencia o la
configuración no coincide, se solicita autorización humana.

### Inspecciones Git de QA y Claude Code

El Auditor reconoce metadatos acotados del repositorio, referencias remotas,
estado de seguimiento, reflog de origin, conteo ahead/behind, rutas individuales
y formatos de resumen de commit. Las lecturas de configuración de ramas,
push.default y origin verifican los valores efectivos antes de autorizar.
La consulta de reglas URL solo se admite cuando no hay reglas configuradas.
Las consultas de configuración global o del sistema no se autoaprueban.
Las operaciones de red de lectura y fetch --dry-run requieren un origin HTTPS
validado, sin reglas de reescritura, credenciales incrustadas ni helpers de
transporte personalizados; dry-run no permite recursión de submódulos.
OpenCode verifica el comando nativo de estas consultas. Claude vincula el
directorio de trabajo comunicado por PreToolUse al identificador del uso de
Bash y valida todos los segmentos de una cadena, incluidos separadores fijos,
timeout acotado de ls-remote, redirección 2>&1 y head acotado.
No se amplían perfiles read-only o approval-required ni se conceden comodines.
Gradle admite tail acotado; sin PIPESTATUS[0] se registra que el exit del
filtro no prueba el resultado de Gradle. Se deben contrastar salida e informes
JUnit. No se autorizan scripts arbitrarios, cambios de remoto o publicaciones
sin la autorización expresa requerida por la política Git.

### Diagnósticos locales acotados (Zen Proxy)

El Auditor valida el comando nativo completo de OpenCode, su correspondencia
con los recursos solicitados y el directorio canónico del proyecto. Admite
consultas de versiones, listados de la raíz, inspección Git básica, hashes
de archivos de código no sensibles, consultas filtradas de servicios y puertos,
estado systemd del servicio con nombre correspondiente al proyecto y campos
ActiveState/SubState/MainPID/LoadState/UnitFileState. Las consultas de HEAD a
GitHub se limitan al repositorio HTTPS mencionado por el usuario en la ronda,
sin reglas de reescritura. Las pruebas npm se permiten cuando package.json
define exactamente node --test y no hay scripts pretest/posttest; se trata
de código ejecutable del proyecto confiable, no de una garantía de aislamiento.
Se excluyen volcados de configuración y variables de entorno, lectura de
credenciales, cambios de servicios y endpoints de administración no validados.

# Evidencias de auditoría de permisos

## 2026-11-24 — ronda 3ce503f8 (proyecto Java/Gradle)

Registro de observaciones; no constituye una concesión de permisos.
Los ejemplos omiten datos de negocio y no contienen credenciales.

| Evidencia SQLite (evento) | Operación | Resultado / decisión |
| --- | --- | --- |
| 18951–18953 | git status --porcelain=v1 -uall; separadores echo; git diff --stat; git log --oneline -3 | Falso positivo por -uall. Regresión añadida a auditor-policy.test.ts. |
| 19018, 19026 | Gradle :model:test :usecase:test y lectura de XML JUnit | 230 pruebas, 0 fallos; candidato a receta de verificación acotada, no a permitir shell general. |
| 19037 | Gradle build --console=plain --rerun-tasks | BUILD SUCCESSFUL, código 0. Los scripts de build ejecutan código del proyecto; no se presupone seguridad por el nombre del comando. |
| 19101–19104, 19110 | JShell con classpath local, DTO y Jackson; echo EXIT_CODE | Revisión puntual de código y DTO, autorización una vez; recibo nativo con salida 0. No autorizar intérpretes arbitrarios. Se añade únicamente el formato fijo de echo EXIT_CODE. |

Criterio: validar argumentos concretos, perfil, directorio y segmentos; no
promover patrones save del proveedor a una lista global. Las operaciones
de escritura Git, scripts arbitrarios e intérpretes permanecen sujetos a
revisión. Una autorización puntual no equivale a una regla permanente.

## Seguimiento de la misma ronda

- Evento 19156: 239 pruebas globales, 0 fallos, 0 errores, 0 omitidas.
- Eventos 19211–19213: Revisor Claude solicita Gradle test con salida
  acotada y código de salida. Aprobación puntual tras verificar que los
  archivos Gradle y wrapper no tienen cambios registrados. Mantener revisión
  de recetas de build hasta definir una política de confianza del proyecto.
- Eventos 19214–19216: cadena Git de inspección desde la raíz explícita
  del proyecto; aprobación puntual. Añadida regresión para validar cadenas
  AND de consultas concretas y separadores, sin cd a rutas externas.

- Eventos 19218–19221 y 19231–19233: scripts de agregación de XML JUnit y
  listado de clases con ls/sed. Aprobación puntual tras inspeccionar el
  contenido; no incorporar intérpretes ni expresiones sed arbitrarias a
  la lista segura. Candidato: herramienta dedicada de informes JUnit.
- Evento 19234: el Revisor confirmó independientemente las 239 pruebas
  y el diff, pero mantiene la observación de identidad del handoff
  del Implementador (ID emitido por orquestador).
- Eventos 19240–19243: los cuatro handoffs se entregaron al Árbitro.
- Evento 19246: aviso SDK unrecognized_model para generate_session_title;
  19247–19248 acreditan la sesión y conexión MCP posterior. No equivale
  por sí solo a un fallo de inferencia.

- Eventos 19283–19289: arbitraje y ejecución finalizados a las 19:27:26
  (hora Colombia). Cinco agentes completados, dos omitidos por plan,
  veredicto funcional con observaciones. Quedan pendientes el contrato
  HTTP, la semántica de campos ausentes y la identidad del handoff del
  Implementador. No se reinició la fábrica durante la ronda.

## Consolidación de reglas

- Se incorporan las consultas Git encadenadas y las recetas Gradle
  acotadas desde el proyecto activo. El perfil workspace-write sigue
  siendo obligatorio. Se rechazan opciones desconocidas, publicación,
  inicio de servicios y wrappers enlazados.
- Se añade summarize_junit al MCP local para reemplazar la lectura de
  XML mediante Python, ls y sed. Limita módulos, archivos y bytes,
  devuelve contadores y marca informes parciales; no ejecuta pruebas.
- Ronda 27dd31e5, eventos 19404–19405: Gradle test con tail -n 60
  fue aprobado una vez tras verificar wrapper y cambios. No se incorpora
  ese pipeline sin código de salida; se recomienda el formato EXIT_CODE.
- Los intérpretes arbitrarios (Python, JShell) no reciben autorización
  global: una prueba puntual revisada no justifica permitir cualquier código.

## Ronda 3 ee31fa64 — validación del despliegue (24 de noviembre)

- 19516: la instrucción de contrato se clasificó como implementación, cinco agentes.
- 19817, 19837: error inicial de compilación Java (excepción verificada no declarada), reparado por el Implementador; repetición con salida 0.
- 19843, 19934, 20039, 20078: uso real de summarize_junit por los dos motores. 241 pruebas, sin fallos, errores ni omitidas.
- 19911, 19955, 20003: pruebas independientes, check y build del Tester con salida 0.
- 20038 y 20077: aprobaciones automáticas de Gradle con recuperación del código de salida en Claude.
- 20041–20043: cadena de Git con separador que contiene paréntesis y diff acotado por head -80. Aprobación puntual. Candidato para una gramática restringida; no autorizar pipelines genéricos.
- 20079–20080: autoaprobación de inspección Git con dangerouslyDisableSandbox=true. Revisar el tratamiento de esta opción explícita antes de ampliar permisos.
- 19852 y 19978: search_text recibió una ruta de archivo en vez de directorio; los agentes recuperaron con la ruta correcta.
- 20093–20094: finalización 20:02:32. Cinco de cinco especialistas planificados; 10 entregas, 6 entre motores, 4 verificadas con identidad completa; tres autoaprobaciones, una autorización puntual, ninguna pendiente. Resumen sustancial y chat persistido. Sin concurrencia entre motores en esta ronda, que siguió olas secuenciales.
- Identidad del informe del Implementador sigue incorporada por el orquestador; el contenido se conserva. Pendientes del proyecto: contrato HTTP, verificación real con IKE y aislamiento de un test de adicionales.

### Correcciones de la auditoría de la ronda 3

- Sandbox: bloqueo explícito en el Auditor y en los dos puntos de control
  de Claude; se solicita repetir sin excepción.
- Git: filtro head numérico acotado sobre comandos de inspección reconocidos
  y separadores literales entre comillas con paréntesis. git remote -v
  permanece sujeto a revisión por potencial exposición de credenciales.
- Handoff: separar progreso solo ante un delimitador explícito inequívoco
  y coincidencia del ID, agente, motor y registro de la ejecución actual.
  El preámbulo se conserva en eventos, no se modifica la evidencia histórica.
- MCP: búsqueda de un archivo regular con los mismos controles que el
  recorrido de directorios; se utiliza la enumeración confinada por descriptor.
- SDK: distinguir únicamente el aviso de generación del título, sin ocultarlo.
  No se cambia el modelo ni el proveedor, ni se afirma haber reparado el SDK.

## Ronda 4 — permisos de publicación Git

La instrucción de la ronda solicitó explícitamente commit y push. Se
recuperaron las cuatro solicitudes reales de OpenCode (inspección, add
multilínea con siete rutas, commit con heredoc citado y push con seguimiento)
y se contrastaron con sus mensajes nativos de session_message. Los cuatro
casos obtuvieron auto en la nueva política: el remoto se verificó en el
proyecto real sin mostrar credenciales; las tres mutaciones se evaluaron en
un repositorio temporal con archivos ficticios, sin repetir operaciones del
proyecto. El remoto Azure DevOps utiliza el identificador público de la
organización repetido en su ruta; no se habilitan otros usuarios ni
contraseñas incrustadas. Se añadieron pruebas de negación de autorización,
rutas, índice, refspecs, destinos, coincidencia nativa y redacción de URLs.
No se concedieron comodines persistentes.

### Ronda 4 — diagnóstico y verificación de ambos motores

Se reprodujeron 24 decisiones de OpenCode Tester con sus mensajes nativos:
22 compatibles con autoaprobación y dos consultas sensibles de configuración
global/sistema excluidas. Las lecturas contextuales comprueban los valores
efectivos sin mostrarlos en el registro de validación.
Las seis solicitudes de Bash de Revisor y Árbitro se incorporaron como
regresiones: cadenas de Git, metadatos de commits, reflog, ahead/behind,
ls-remote con timeout, fetch --dry-run y dos formas de verificación Gradle.
Se utiliza el cwd informado por el hook SDK para la evaluación de Bash.
Los pipelines Gradle sin PIPESTATUS reciben una limitación explícita sobre
la evidencia de salida. Las reproducciones evalúan permisos; no ejecutan
los comandos remotos ni vuelven a ejecutar los agentes.

## Ronda Zen Proxy dca82e8f — 24 de noviembre, 21:23

Evidencia: Build entregó HANDOFF-BUILD-DCA82E8F (autor agent); Architect
(Claude) y Build (OpenCode) entregaron al Implementador (eventos 21158–60).
Suite Node: 381 pruebas, 379 aprobadas, 2 omitidas, ninguna fallida,
EXIT_CODE=0 (21055). La prueba de inferencia local terminó por timeout de
90 segundos (21137); el servicio estaba activo, con diez modelos limitados.
La comparación de hashes confirmó código principal actualizado (21242),
catálogo local obsoleto (21241). No se demuestra la causa exacta del límite
externo ni que reiniciar o reinstalar lo resuelva.

Permisos: commits 65fdc85, 7aad5a4, 3709ee2 introdujeron recetas de
diagnóstico local, metadatos públicos y detección de manifiestos.
Las nuevas variantes sin workdir se admiten solo para operaciones que no
dependen del directorio actual: versión, fecha UTC, estado systemd del
servicio cuyo nombre coincide con el proyecto y campos de estado
acotados, /health y /v1/models en loopback para Zen Proxy con manifiesto
y configuración verificados sin imprimir credenciales. No se concede
automáticamente acceso a /api/status sin sanitizar, /api/logs, /api/test,
inferencia, archivos temporales fijos, argumentos de procesos, Environment,
ExecStart o unidades completas. Las operaciones previamente autorizadas
de forma puntual no constituyen permiso permanente. Los comandos que
combinan cd y separadores capaces de continuar tras su fallo no se
admiten sin evidencia del cwd. No se debilita el control de rutas.

En la reproducción de 23 solicitudes registradas (21:23:33), diez
obtuvieron auto; trece quedaron en revisión, incluidas solicitudes
rechazadas anteriormente y variantes que requieren reglas adicionales.
Las nuevas reglas se probaron contra recursos nativos, perfiles,
destinos, credenciales y comandos adicionales. Verificación 218/218.
La ronda sigue activa: no se ha reiniciado el servicio de la fábrica.
Pendientes de mejora: PATH de Bun, lectura MCP paginada de archivos
mayores a 128 KiB y diagnóstico de servicios sin revelar configuración.

### Continuación — 21:29

El Implementador creó los respaldos de models.json y zen-proxy.json,
conservó los permisos 0600 del segundo y actualizó models.json. El catálogo
tiene diez identificadores únicos y SHA-256 idéntico al catálogo remoto
descargado (evento 21289). La segunda suite npm continúa en ejecución.
Se incorporó la consulta de versión de OpenCode en su ruta instalada,
el hash de una lista literal de archivos públicos con sustitución fija
y la validación exacta del resumen de models.json. También se admite
npm test seguido de la impresión del código de salida y cd canónico
condicional. No se autorizó node -e general.
En el replay de 28 solicitudes (21:29:42) la política emite auto en 13 y
revisión humana en 15: siete habían sido rechazadas y ocho aprobadas
puntualmente. Las variantes con lectura de rutas relativas después de
un cd que puede fallar, volcado de status administrativo, inferencia
o archivos temporales fijos requieren contexto adicional; no se
convierten en comodines. La forma equivalente con workdir verificado
o cadena condicional está contemplada para comparaciones de hashes.
Se añadieron instrucciones para reutilizar evidencia entre agentes,
no repetir inferencia tras 429/timeout, usar workdir y encadenamiento
condicional, y conservar permisos privados al respaldar configuración.
Commits 782d9c7 y 27fb56a publicados. Verificación 220/220 en el primero,
typecheck correcto en el segundo. No se ha reiniciado la fábrica durante
la ronda activa.

### Continuación — 21:33

El Implementador confirmó catálogo actualizado, respaldo privado de
configuración y reinicio puntual de zen-proxy.service. Se verificó que
la configuración conserva exactamente los bytes originales y el proceso
pertenece al usuario y al proyecto antes de conceder el reinicio una vez.
El PID cambió de 6936 a 210719 y el servicio volvió activo. El estado
posterior todavía muestra 0 modelos disponibles, 10 limitados. No se
habilita systemctl restart de forma general ni volcados administrativos.
Se autorizó una comprobación puntual de metadatos de archivos, no su
contenido; la política admite ls -l acotado en raíz comprobada o cd
condicional. Las cadenas que pueden seguir tras un cd fallido permanecen
en revisión si no hay cwd confirmado.
Se corrigió la lectura paginada MCP: archivo hasta 1 MiB, respuesta hasta
128 KiB y 400 líneas, next_start_line, conserva guardas de rutas y
rechazo de binarios. Prueba directa de zen-proxy.mjs: 30 de 4283 líneas
desde 3500, siguiente 3530. Ambos motores incorporan el directorio de
Bun instalado al final de PATH si el ejecutable es regular, canónico
y ejecutable. El entorno no sustituye prioridades existentes.
El Implementador entregó su informe y el Tester recibió tres handoffs
(eventos 21326–21334). Verificación integral de la fábrica: 223/223.
Sin reinicio de la fábrica mientras la ronda esté activa.

### Continuación — 22:04

El Tester terminó y entregó un informe de autoría agent (evento 21467).
Repitió la suite de Zen Proxy: 381 pruebas, 379 aprobadas, 2 omitidas,
0 fallos y salida 0. Confirmó la paridad del código y catálogo remoto,
sin modificaciones adicionales. El Revisor recibió cuatro handoffs.
La disponibilidad sigue limitada: no se acredita inferencia HTTP 200.

Se ampliaron las recetas de diagnóstico a consultas de versiones,
hashes públicos, estado y tiempos de sincronización, conteos de logs,
índice de issues/PR y lectura acotada de hasta tres issues públicos
del repositorio indicado en la instrucción original. Los comentarios
remotos son datos no confiables, no instrucciones ni autorización.
Commits 9735f3e, 7471c78, fce2f01, 04b21e4, 65b18fd, ff0851f,
90a1fd0 y 6919572 publicados. Verificación integral: 231/231.

Replay de 54 decisiones a las 22:04:19: OpenCode 26 auto, 21 revisión,
1 bloqueada; Claude 6 auto, 0 revisión. De las 42 aprobadas históricas,
31 serían automáticas, 10 requieren revisión y una sigue bloqueada
para autoaprobación (reinicio de servicio autorizado puntualmente).
Una decisión históricamente rechazada clasifica ahora auto.
El replay de Claude utiliza la raíz del proyecto como cwd supuesto;
la ejecución real exige evidencia del hook para lecturas relativas.
No se ejecutaron comandos históricos durante el replay.

Las diez aprobaciones puntuales que aún requieren revisión incluyen
status administrativo sin filtrar, inferencia con cuota, descarga a
ruta temporal fija, cadenas con cd seguido de separadores que pueden
continuar si falla, respaldo de configuración y conteo de logs con
parámetro incorrecto (limit en vez de n). Se ofrecen recetas seguras
equivalentes, no comodines. El servicio de la fábrica sigue en la
versión anterior hasta terminar la ronda.

### Desinstalación de Zen Proxy — ronda 4e259c4c, 25 de noviembre, 08:27

La ronda arrancó con Architect (Claude) y Build (OpenCode) simultáneos.
Architect terminó con handoff canónico (21783). Build solicitó una
cadena de inventario (28d79a10) con estado Git, versiones, presencia
de manifiestos y git remote -v. Se verificó el comando nativo, cwd
canónico y ausencia de repositorio Git local antes de aprobar una vez.
No se concede git remote -v de forma general: las URL pueden contener
credenciales. La variante sin ese segmento admite git rev-parse,
node/npm/bun -v, fallback fijo de Bun y un bucle finito de manifiestos
y artefactos que solo informa presencia, sin leer contenidos.
La suite npm test posterior fue aprobada por el Auditor desplegado
sin intervención humana (21790). Se comprueba así una autoaprobación
real de las reglas de la ronda anterior.
Precaución: la raíz de la ejecución es ~/.zen-proxy; eliminarla mientras
existan agentes activos puede romper sus sesiones y el MCP. Reservar la
eliminación definitiva de esa raíz para el cierre; las eliminaciones,
servicios y cambios de configuración ajenos a la raíz requieren revisión
específica. No ampliar permisos genéricos de borrado.

### Desinstalación — continuación 08:32

Build obtuvo salida 0 y un resumen de 381 pruebas, 379 aprobadas,
2 omitidas y ninguna fallida (21793). El resumen coincide con el
de la ronda anterior; no se considera prueba de desinstalación.
Se autorizó puntualmente la consulta bf2729cd tras comprobar los
archivos canónicos y el manifiesto. Se incorpora una receta que
permite leer hasta diez líneas de zen-proxy.mjs, listar metadatos
de los wrappers exactos y enumerar scripts npm sin ejecutarlos,
únicamente con definiciones conocidas y sin workspaces. No se
autoriza npm run con un script arbitrario ni lectura de secretos.
Pruebas negativas cubren rutas externas, symlinks, scripts
desconocidos y comandos anexados.

### Desinstalación — continuación 08:43

Build completado; Ingeniería inversa inició inventario. Se aprobaron
tres solicitudes verificadas: bc7bd315 (command -v y readlink de los
tres lanzadores), 2fea92d2 (estado systemd y puerto 8787) y b30a4253
(salud, PID, nombres del drop-in y existencia de tres directorios
externos). Los tres lanzadores resuelven a archivos de ~/.zen-proxy.
Se añaden recetas de inspección exactas: nombres zen-proxy, zen-claude,
claude-zen; readlink limitado a ~/.local/bin y esos nombres; filtro
awk fijo para el puerto local configurado; inventario de nombres del
drop-in canónico y presencia de ~/.config/opencode, ~/.claude y
~/Documents. No habilita lecturas de contenido externo, awk arbitrario,
ejecución de wrappers ni eliminación de servicios o archivos.
Pruebas positivas y negativas para destinos ajenos, expansión de
comandos, listado recursivo y comandos anexados.

Se revisó además 940918ad: conteos de procesos y listado de nombres
con *zen* en directorios concretos. Se concedió una sola vez al
confirmar que las coincidencias eran los tres lanzadores y el enlace
default.target.wants/zen-proxy.service. La regla permanente reconoce
solo los dos conteos pgrep -c -f exactos (no argumentos de procesos),
sin autorizar glob general ni borrado. Los conteos no prueban por sí
solos la ausencia de procesos: contrastar PID y estado de systemd.
Verificación integral: 236/236.

Se aprobó b2071fe0 tras verificar que PID 2788 era MainPID del
servicio Zen Proxy. Nueva receta permanente para ps -o pid=,comm=
-C bun/node y consulta de PID específico, limitada al usuario y cwd
canónico del proyecto. No se exponen args, entorno ni cmdline.

Se autorizó e7fba951: bucle de existencia de dos unidades de sistema
y dos archivos del proyecto, sin leer su contenido. Receta exacta
incorporada; no permite otros servicios ni modificación de /etc.

### Desinstalación — continuación 09:02

Ingeniería inversa completó su handoff y el Implementador recibió
los tres informes anteriores. Se concedieron puntualmente 00c33588
(inventario de servicio, lanzadores, drop-in y directorios) y cd78c7bf
(nombres de nivel superior de Documents, OpenCode y Claude, metadatos
de archivos de inicio de shell), tras verificar rutas y directorios
canónicos. No se convierten esos scripts multilínea ni las
enumeraciones generales del home en permisos permanentes. Se
incorporan alternativas acotadas: ls -ld/ls -d de rutas absolutas
exactas del inventario, y el orden alternativo de opciones de ps
para columnas PID y comm de Bun/Node. Sin lecturas de configuración,
argumentos completos de procesos, modificación ni eliminación.

### Desinstalación — continuación 09:07

Se rechazaron 6adde2ef (búsqueda que imprimía líneas completas de
configuración de shell) y da41e4d7 (enumeración de carpetas ajenas al
desarrollo). Se aprobaron de forma puntual 7526a63c (localización de
directorios por nombres de los proyectos requeridos, profundidad
limitada y sin leer archivos) y 498a3a26 (inventario de dos raíces de
repositorios verificadas). La aprobación previa 3bdc8305 fue resuelta
desde la interfaz, no por el auditor externo. No se añade un permiso
general para find, ls del home, grep recursivo ni lectura de
configuraciones externas. Se añade la consulta exacta command -v jq
y se refuerza el prompt común para limitar inventarios a las rutas
autorizadas, no imprimir credenciales, separar diagnóstico y cambio,
y conservar la raíz de trabajo durante las fases activas.

Se concedió puntualmente 719d5fff tras contrastar la llamada nativa
y las cuatro raíces canónicas (fábrica, examResolve, aulaResearchStudio,
autogestionback). La consulta solo devuelve nombres de archivos con
coincidencias, limita la salida y excluye directorios de dependencias
y construcción. Una coincidencia no acredita integración activa;
debe clasificarse antes de modificar. Sin permiso general de grep
fuera del workspace ni autorización de escritura. Verificación
integral del cambio anterior: 240/240.

### Desinstalación — continuación 09:10

Se concedieron puntualmente ba73d675 y 86f490fd tras verificar las
llamadas nativas completas, los dos archivos JSON canónicos de
OpenCode, su propiedad, tamaño y validez estructural. La primera
consulta devuelve únicamente rutas de claves coincidentes; en ambos
archivos la coincidencia fue providers.zen-proxy.settings.baseURL.
La segunda consulta enumera claves, tipos y modelos; se comprobó
que models es un objeto y no un valor arbitrario, y que las claves
y los identificadores proyectados tienen formato ordinario.
Ninguno de los dos archivos selecciona zen-proxy como modelo
predeterminado o small_model. No se concede jq arbitrario ni
lectura general de configuraciones externas. Las dos decisiones
son específicas de esta ejecución y no autorizan cambios.

### Desinstalación — comprobación del Auditor 09:15

Evento 21790 acredita una autoaprobación real del Auditor desplegado:
npm test del Build, sin intervención y sin comodines. La versión
ejecutada sigue siendo la compilada el 25 de noviembre a las 03:10 UTC.
Replay de 19 decisiones históricas con política del código fuente
actual: 6 auto, 13 revisión, 0 bloqueadas; incluye la solicitud
b694b5a6, entonces pendiente, aprobada puntualmente tras verificar
llamada nativa y cinco archivos fuente canónicos. Salida 0 (22016).
Las referencias halladas en esa consulta corresponden a política
de diagnóstico y sus pruebas, no a un proveedor activo en models.ts,
server.ts o execution.ts. No se concede búsqueda general en proyectos
externos ni lectura de configuración por coincidencias de palabras.
A las 09:15:05: 17 aprobadas mediante revisión, 2 rechazadas, ninguna
pendiente, más una aprobación automática registrada como evento.
Se mantiene el despliegue vigente para no interrumpir la ronda.

### Desinstalación — continuación 09:16

Se rechazó c940c14b porque mezclaba diagnósticos de existencia y
conteos con la enumeración del almacén de autenticación. Se aportó
evidencia independiente: cero líneas coincidentes en .bashrc,
.profile y .claude/settings.json, y ausencia de los directorios
zen-proxy bajo .local/share, .cache, .config y .local/state.
Se incorpora una alternativa de conteo grep -cE con patrones
literales y tres archivos canónicos exactos, propiedad del usuario
y tamaño máximo de 1 MiB. No permite grep -n, auth.json, volcados de
configuración ni comandos añadidos.

### Desinstalación — actualización 09:22

Se aprobó 10e49ea5, comparación de formato JSON con salida reducida
a indicadores; se rechazó f9592d1d por temporales predecibles y
riesgo de exposición transitoria de configuración privada.
La variante 2e87d57c fue aprobada puntualmente tras verificar
rutas, propiedad, respaldo privado, umask, temporales únicos y
el cambio semántico exacto. Aunque la ejecución devolvió código 1,
ambos JSON quedaron sin providers.zen-proxy y se comprobó igualdad
estructural con sus respaldos tras retirar esa única entrada, modos
0600 y 0664 preservados y ausencia de temporales. El respaldo sigue
privado (0700), pendiente de limpieza final tras validación.
Se autorizó una sola vez bed87dc8, detención y deshabilitación
de la unidad concreta, verificando MainPID, propietario y cwd.
Resultado: inactive, disabled, MainPID=0, puerto 8787 libre.
No se añade autorización automática de stop/disable ni borrados.
La solicitud a1435a37 sigue pendiente de revisión humana; el
control de seguridad impidió su aprobación remota y no se repite.
A las 09:22: 20 aprobadas, 4 rechazadas, 1 pendiente y una
autoaprobación registrada aparte. La fábrica sigue saludable.
opencode.json del repositorio tiene cambios del Implementador;
no se incluyen en commits de documentación de la auditoría.

### Desinstalación — verificación 09:38

La unidad y el drop-in ya no existen, tampoco el enlace de inicio
automático ni los tres lanzadores. Las decisiones a1435a37, 5e5f3af0,
38c121f3 y d3606b36 fueron atendidas desde la interfaz, no por este
auditor externo. Se concedió puntualmente 5fe1ef0e (validación final,
sin escrituras); evento 22135, salida 0: not-found/inactive, cero
coincidencias de puerto, tres comandos no encontrados y JSON válidos
con LM Studio conservado. Se verificó independientemente OpenCode
v2.1.4 con salida 0; Claude Code 2.1.327 en el resultado del agente.
La consulta de metadatos de las tablas de configuración detectó
cero referencias a Zen Proxy en favoritos, asignaciones y preferencia
de proveedor Claude. Se rechazó 1075ba22 por escritura temporal fija
innecesaria, proporcionando dichas evidencias. Nueva regla de
conteos exactos de unidades, procesos Bun y sockets del puerto
configurado, sin conceder stop/disable/borrado ni consultas generales.
La raíz ~/.zen-proxy y el respaldo privado permanecen pendientes de
limpieza al cierre. Se conserva el cambio de opencode.json del
Implementador sin incorporarlo al commit de auditoría.

### Desinstalación — continuación 09:40

Se concedieron 32f55422 (inventario de respaldos, exclusivamente
nombres; el respaldo histórico de OpenCode contiene referencias,
sin que ello acredite una integración activa), 213841b7 (scripts de
package.json verificados), ebaa92a9 (67 líneas de verify-factory.sh)
y e851aab3 (metadatos de lanzadores y versión Claude). Se verificó
la llamada nativa, archivos canónicos y alcance de cada consulta.
No se concede sed o jq arbitrario ni lectura general de otros
repositorios. La nueva receta admite consultas absolutas exactas
del lanzador Claude, cuyo destino debe ser un ejecutable propio
en .local/share/claude/versions con nombre de versión; y metadatos
del ejecutable OpenCode canónico. No autoriza otros argumentos,
escrituras ni enlaces a binarios ajenos. La variante multilínea
observada sigue requiriendo revisión; no se amplían permisos de
shell por equivalencia textual.

### Desinstalación — QA 09:45

Implementador completado; evento 22185 confirma recepción de
los cuatro handoffs por Tester, incluido el Arquitecto de Claude.
Se rechazó 4d340bda por enumeración de directorios educativos
ajenos al objetivo y se indicaron las cuatro raíces verificadas.
Se concedieron puntualmente 10a739f3 (proyecciones estructurales
de opencode.json y claves de scripts) y be3d09ae (solo metadatos
de cuatro rutas por proyecto, sin leer .env). ExamResolve y
aulaResearchStudio tienen JSON válidos sin marcadores Zen Proxy;
autogestionback no tiene los cuatro archivos consultados en su raíz.
Se añaden alternativas exactas de QA: pgrep -c -x bun/node y
systemctl --user list-unit-files 'zen-proxy*', acotadas a la raíz
Zen Proxy; no se permite obtener argumentos de procesos ni
enumerar unidades arbitrarias. Las consultas multilínea externas
siguen bajo revisión específica. El servicio continúa ausente,
el puerto libre y la raíz de trabajo y respaldo privado intactos.

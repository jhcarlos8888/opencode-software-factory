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

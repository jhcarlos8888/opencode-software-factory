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

# Factory Control Center

Interfaz local de operación de OpenCode Software Factory. Coordina agentes de OpenCode y Claude Code, conserva el historial en SQLite y exige una preconsulta y decisiones humanas antes de iniciar una tarea nueva.

## Requisitos

- Linux con Node.js 24 o superior.
- OpenCode CLI instalado y autenticado/configurado.
- Claude Code CLI instalado para habilitar su motor.
- Python 3, jq y las herramientas del repositorio para la verificación integral.
- Las credenciales permanecen en las instalaciones locales de cada herramienta; no se almacenan en el repositorio ni en el manifiesto del equipo.
- La línea base de seguridad, incluida la excepción temporal de picomatch, está registrada en docs/SECURITY-BASELINE.md.

## Desarrollo local

Desde este directorio:

~~~bash
npm install
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

## Ejecución y permisos

- Cada agente tiene motor, modelo favorito y perfil de permisos independiente.
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

- **Autoaprobación de bajo riesgo:** consultas Git de solo lectura,
  `npm run check`, `npm run test:unit`, `npm run smoke` (incluida la
  visualización limitada `2>&1 | tail -20; echo "SMOKE_EXIT=${PIPESTATUS[0]}"`),
  y algunas
  acciones de navegador local (navegar a inicio/salud, redimensionar,
  consola, capturas confinadas). Cada permiso se concede **una sola vez**,
  con el perfil `workspace-write` y durante la ronda activa.
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

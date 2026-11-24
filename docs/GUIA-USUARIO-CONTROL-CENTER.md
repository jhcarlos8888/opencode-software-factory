# Guía de operación — Factory Control Center

## 1. Abrir el Centro de Control

En este equipo, el Control Center funciona como servicio de usuario de systemd y se inicia automáticamente.

Dirección local:

http://127.0.0.1:4141/

Iniciar si está detenido y comprobar su estado:

~~~bash
systemctl --user start factory-control-center.service
systemctl --user status factory-control-center.service
curl -sS http://127.0.0.1:4141/api/health | jq
~~~

No ejecutes npm start mientras el servicio systemd esté activo: ambos intentarían utilizar el puerto 4141.

Para ver los logs:

~~~bash
journalctl --user -u factory-control-center.service -n 100 --no-pager
~~~

### Después de cambios de código

No basta con compilar. El procedimiento normal de despliegue es:

~~~bash
cd control-center
npm run deploy
~~~

La verificación incluye tests, typecheck, auditoría npm, validador del instalador y registro real de los siete agentes. El despliegue recompila, reinicia el servicio y comprueba que el fingerprint cargado en memoria coincide con el artefacto del disco.

En el panel aparece una advertencia si el proceso activo está desfasado. El endpoint de salud publica el estado del build y sus dos fingerprints.

## 2. Flujo de una ejecución nueva

El flujo tiene que completarse en este orden:

1. **Proyecto de trabajo:** escribe una ruta absoluta o utiliza Elegir carpeta.
2. **Preconsulta del proyecto:** analiza el proyecto en modo de solo lectura. Revisa stack, estructura, manifiestos, instrucciones, Git y contexto relevante.
3. **Propuesta:** la fábrica recomienda agentes y modelos usando exclusivamente los modelos favoritos activos.
4. **Decisión:** acepta la propuesta automática o elige configuración manual.
5. **Equipo:** si aceptaste la propuesta o seleccionaste la opción manual, guarda el equipo. Una configuración manual también debe guardarse después de seleccionarla.
6. **Iniciar instrucciones:** solo se habilita cuando la preconsulta sigue vigente, existe una decisión explícita y el equipo está guardado.

La API vuelve a comprobar estas condiciones. No depende únicamente del botón o del estado de la interfaz. Si cambias la ruta, las instrucciones o el equipo, vuelve a ejecutar la preconsulta antes de iniciar.

La preconsulta no ejecuta agentes ni modifica archivos. La ejecución comienza después de completar el flujo.

## 3. Equipo de agentes y favoritos

El equipo contiene siete especialistas:

| Agente | Responsabilidad |
| --- | --- |
| Build | construcción, manifiestos y herramientas de calidad |
| Architect | arquitectura y contexto del proyecto |
| Implementer | cambios de código y pruebas |
| Reviewer | revisión independiente |
| Tester | build, pruebas y evidencia |
| Reverse | reconstrucción de flujos y análisis inverso |
| Cloud Arbiter | consolidación final y resolución de discrepancias |

Cada agente tiene motor, modelo y perfil de permisos independiente. Los modelos asignables deben pertenecer a los favoritos activos del motor/proveedor. Si eliminas un favorito utilizado por el equipo, la API impide iniciar hasta que corrijas la asignación.

Los proveedores y credenciales permanecen en las instalaciones locales de OpenCode y Claude Code. El Control Center no debe almacenar ni imprimir tokens.

## 4. Ejecución, actividad y decisiones

La consola registra eventos de orquestación, agentes, sesiones, handoffs, verificaciones y errores reales.

El Centro de decisiones atiende solicitudes de permiso y preguntas que llegan de las sesiones de los motores. Una decisión puede estar pendiente, enviándose, aprobada, rechazada, respondida o marcada para revisión cuando el estado del motor no se puede reconciliar.

- **Permitir una vez:** autoriza la operación solicitada una sola vez.
- **Permitir durante esta ejecución:** conserva una autorización temporal limitada al agente que la solicitó y a los recursos concretos aprobados.
- **Rechazar:** devuelve una denegación al motor.
- **Responder:** envía el texto o los valores pedidos por el formulario.

No confundas una aprobación temporal con un permiso global. Las aprobaciones no deben transferirse de Architect a Reviewer ni de un agente a otro. Si el motor deja de confirmar el estado de una solicitud, la fábrica debe cerrarla para revisión y no volver a aprobarla automáticamente.

No apruebes una operación cuyo recurso, alcance o efecto no esté claro. El hecho de que un agente la solicite no constituye autorización.

## 5. Procesos persistentes y continuación

Las ejecuciones iniciales generan un proceso de trabajo persistente. El historial conserva instrucciones, mensajes, rondas, configuración histórica, decisiones, aprobaciones, eventos y handoffs.

Cuando una ronda termina, utiliza la opción de continuación del proceso para dar la siguiente instrucción. La fábrica conserva el objetivo original y el contexto anterior, sin presentar una configuración histórica como si fuera la configuración actual.

La cancelación detiene sesiones y procesos de la ejecución activa. El backend impide iniciar otra ejecución mientras la anterior siga activa o en proceso de cancelación.

## 6. Perfiles y límites de seguridad

- **Solo lectura:** inspección del proyecto mediante el MCP local de lectura; no concede shell ni herramientas de escritura.
- **Escritura en workspace:** permite cambios dentro del proyecto conforme a las reglas de seguridad.
- **Requiere aprobación:** solicita autorización humana para las operaciones sensibles.

Las rutas sensibles, los secretos, los metadatos Git y los accesos fuera del proyecto se bloquean en las capas disponibles. Las lecturas MCP no siguen symlinks, comprueban la identidad del descriptor y tienen límites de tamaño y profundidad.

La API está enlazada a loopback. Rechaza orígenes de navegador externos y solicitudes cross-site. No expongas el panel ni el servidor Vite en una interfaz de red pública.

La línea base de seguridad y la excepción temporal de la dependencia picomatch están documentadas en docs/SECURITY-BASELINE.md.

## 7. Diagnóstico

Salud del servicio y fingerprint:

~~~bash
curl -sS http://127.0.0.1:4141/api/health | jq
~~~

Motores instalados:

~~~bash
curl -sS http://127.0.0.1:4141/api/engines | jq
~~~

Catálogos:

~~~bash
curl -sS http://127.0.0.1:4141/api/models/opencode | jq
curl -sS http://127.0.0.1:4141/api/models/claude | jq
~~~

Servicio y puerto:

~~~bash
systemctl --user status factory-control-center.service
ss -ltnp | grep 4141
~~~

Si la interfaz indica que el runtime está desfasado, ejecuta npm run deploy desde control-center. Si la API no responde, revisa primero el estado de systemd y los logs; no inicies una segunda instancia a ciegas.

## 8. Límites conocidos y trabajo pendiente

- La fábrica serializa las ejecuciones activas; no ejecuta varios trabajos escritores concurrentes.
- No crea todavía Git worktrees aislados por agente. Los agentes autorizados trabajan sobre la ruta de proyecto seleccionada. Antes de una tarea real, revisa el estado Git y conserva los cambios locales.
- No existe garantía de colaboración bidireccional completa solo porque los agentes hayan terminado. Deben existir handoffs verificados en ambas direcciones, con identidad, contenido, hash, recepción y utilización.
- La última ronda real de validación (Ronda 4, 17 de noviembre de 2026) ejecutó los siete agentes y produjo 18 handoffs, pero el Árbitro dejó sin verificar la dirección Claude → OpenCode. También registró defectos de alcance en las autorizaciones de aquella ejecución. El generador de permisos se endureció después y tiene pruebas unitarias de regresión; la validación bidireccional de extremo a extremo debe repetirse con una nueva ronda controlada.
- En esa ronda, el script de prueba Java necesitó un JDK presente en PATH. Que exista un JDK dentro de un IDE no significa que el terminal o el servicio lo encuentre automáticamente.
- El Control Center es una herramienta local de un solo usuario. No es una plataforma multiusuario ni un servicio remoto.
- La dependencia de desarrollo picomatch mantiene una excepción temporal de seguridad hasta que el upstream publique una versión corregida. Mantén Vite solo en loopback.

La verificación automatizada de la fábrica no sustituye una prueba funcional con proveedores reales. Los resultados no ejecutados o no verificables deben reportarse como pendientes, no como aprobados.

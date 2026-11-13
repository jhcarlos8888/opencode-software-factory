# Guía de uso — Factory Control Center 0.1.0

## 1. Iniciar la aplicación

La forma recomendada es producción local, con interfaz y API en el mismo puerto:

```bash
cd "/home/jcherre/Documents/PERSONAL/PROYECTOS, NEGOCIOS Y FINANZAS/NEGOCIOS/PROGRAMACION/opencode-software-factory/control-center"
npm start
```

Abrir en el mismo computador:

http://127.0.0.1:4141/

Mantener abierta la terminal mientras se utiliza. Para detener el servidor, pulsar `Ctrl+C`.

Si se desea reconstruir después de cambios de código:

```bash
npm run typecheck
npm run build
npm start
```

Alternativa para desarrollo (dos servidores):

```bash
npm run dev
```

Abrir http://127.0.0.1:5173/. En este modo Vite sirve la interfaz y Fastify la API en 4141.

## 2. Qué muestra el panel

- **Centro de operaciones:** estado de los CLIs instalados, cantidad de modelos detectados y número de agentes configurados.
- **Proyecto de trabajo:** escribir una ruta absoluta o pulsar **Elegir carpeta** para abrir el selector nativo del escritorio. La carpeta elegida rellena el campo; después pulsa **Preconsulta del proyecto** para iniciar el análisis de solo lectura. El análisis actual es estructural y de solo lectura: manifiestos, stack probable, archivos de instrucciones y estado Git.
- **Equipo de agentes:** asignar a cada agente OpenCode o Claude Code, elegir un modelo/alias, seleccionar un perfil de permisos y activar/desactivar el agente. Pulsar Guardar equipo para persistir los cambios en SQLite.
- **Skills:** inventario de Skills originales detectadas bajo `.opencode/skills`.
- **Orquestación:** muestra el siguiente hito planificado; el debate y ejecución multi-motor aún no están implementados.

## 3. Recomendación para las primeras pruebas

1. Abrir el panel y verificar que ambos CLIs aparezcan detectados.
2. En Proyecto de trabajo, analizar primero un repositorio de prueba o uno que no tenga cambios importantes pendientes.
3. Revisar la sección Git antes de cualquier futura ejecución; si hay modificaciones locales, conservarlas y no asumir que el panel las respaldará.
4. En Equipo de agentes, explorar los selectores sin guardar si solo se está conociendo la interfaz.
5. Si se cambia una asignación, pulsar Guardar equipo. La selección queda almacenada localmente, fuera del repositorio.
6. Volver a cargar la página para comprobar que las asignaciones persisten.

## 4.1 Preconsulta, consola y decisiones

La preconsulta prepara una recomendación con los modelos favoritos, pero no ejecuta motores ni modifica archivos. La propuesta aparece como pendiente y debe aceptarse explícitamente o descartarse para configurar el equipo manualmente. Después de aceptarla, pulsa «Guardar equipo» para persistir las asignaciones.

La Consola de actividad registra acciones reales del Control Center (preconsulta y configuración). Aún no es una terminal de OpenCode/Claude: la salida real de los motores requiere los adaptadores de ejecución y streaming.

El Centro de decisiones es el espacio previsto para solicitudes de permiso y preguntas de los agentes. Su cola se activará cuando se conecten las sesiones y las APIs de aprobación/respuesta; todavía no hay ejecución de agentes ni solicitudes reales que atender.

## 4. Límites importantes de la versión 0.1.0

Esta versión es un panel de descubrimiento y configuración, no un orquestador de tareas todavía.

- No envía prompts a Claude ni a OpenCode.
- No crea sesiones ni hace que los motores conversen entre sí.
- Los modelos elegidos se guardan como configuración, pero todavía no se utilizan en una ejecución.
- Los perfiles "Solo lectura", "Requiere aprobación" y "Escritura en workspace" se registran, pero todavía no aplican restricciones reales a procesos. No interpretar una selección como una barrera de seguridad ejecutable.
- El análisis de proyecto no modifica archivos ni ejecuta comandos del proyecto.
- Claude Code y OpenCode conservan su autenticación propia. No copiar tokens ni API keys al panel.

No utilizar aún este panel para autorizar modificaciones automáticas. La fase de ejecución deberá implementar y probar aislamiento, permisos efectivos, registro de acciones, cancelación y aprobación humana antes de habilitar escritura.

## 5. Diagnóstico rápido

Comprobar que la API responde:

```bash
curl -s http://127.0.0.1:4141/api/health
```

Comprobar motores:

```bash
curl -s http://127.0.0.1:4141/api/engines
```

Comprobar los catálogos:

```bash
curl -s http://127.0.0.1:4141/api/models/opencode
curl -s http://127.0.0.1:4141/api/models/claude
```

Si no abre el navegador, confirmar que `npm start` sigue activo y que el puerto 4141 está escuchando:

```bash
ss -ltnp | grep 4141
```

Si aparece "address already in use", ya puede haber una instancia activa; revisar `curl` antes de iniciar otra.

## 6. Datos y seguridad

- La API se enlaza a `127.0.0.1`, no a todas las interfaces de red.
- Las asignaciones se guardan en `~/.local/state/opencode-software-factory/control-center/`.
- El panel no almacena credenciales de proveedor.
- La fábrica original, agentes y Skills se mantienen en su ubicación original.


## 7. Servicio automático (configurado en este equipo)

El Centro de Control está instalado como servicio de usuario de systemd y se inicia automáticamente. No es necesario abrir una terminal y ejecutar `npm start` cada vez.

```bash
systemctl --user status factory-control-center
systemctl --user start factory-control-center
systemctl --user stop factory-control-center
systemctl --user restart factory-control-center
```

Después de reiniciar el equipo, abrir http://127.0.0.1:4141/.

Para revisar errores:

```bash
journalctl --user -u factory-control-center -n 80 --no-pager
```

No iniciar manualmente `npm start` mientras el servicio ya esté activo; se ocuparía el puerto 4141.

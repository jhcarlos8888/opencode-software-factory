# Factory Control Center

Interfaz local de control de OpenCode Software Factory.

## Requisitos

- Node.js 24 o superior.
- OpenCode CLI instalado y autenticado/configurado.
- Claude Code CLI instalado para habilitar su motor.
- Las credenciales permanecen en las instalaciones locales de cada herramienta.

## Desarrollo local

Desde este directorio:

```bash
npm install
npm run dev
```

Abrir http://127.0.0.1:5173

La API escucha únicamente en 127.0.0.1:4141. Vite redirige las solicitudes `/api` a esa API.

## Funcionalidad implementada en 0.1.0

- Detecta los ejecutables y versiones de OpenCode y Claude Code.
- Descubre el catálogo de modelos de OpenCode mediante su CLI.
- Expone los alias de modelo Claude Code (son resueltos por Claude al ejecutar).
- Lee los siete agentes y las diez Skills propias de la fábrica.
- Permite asignar motor, modelo y perfil de permisos individualmente a cada agente.
- Guarda las asignaciones en SQLite bajo `~/.local/state/opencode-software-factory/control-center/`.
- Analiza un directorio de proyecto en modo de solo lectura: stack, manifiestos, documentos e información Git.

Esta versión no ejecuta agentes ni modifica proyectos. Tampoco valida todavía que las credenciales permitan completar una llamada al proveedor. La coordinación y ejecución se habilitarán después de implementar y probar los adaptadores de motores.

## Producción local

```bash
npm run build
npm start
```

La interfaz y la API se sirven desde el mismo origen en http://127.0.0.1:4141. En desarrollo se mantienen Vite (5173) y Fastify (4141) separados.

## Comprobaciones

```bash
npm run typecheck
npm run build
npm audit --omit=dev
```

No guardar API keys, tokens o credenciales en este repositorio. No se modifican las configuraciones globales de OpenCode ni Claude Code.

# Auditoría inicial — 2026-11-12

## Alcance y seguridad

Auditoría de solo lectura del repositorio fuente. No se modificó ningún agente, Skill, configuración, instalador ni proyecto consumidor. Se conserva la modificación local preexistente de `scripts/factory.py`.

## Estado Git

- Rama: `master`, alineada con `origin/master` en `ae730e4`.
- Modificación local previa: `M scripts/factory.py`.
- El diff local cambia `doctor()` para derivar proveedor/modelo esperados desde el `opencode.json` del proyecto destino. Debe preservarse.
- No se creó commit ni se descartó ningún cambio.

## Capacidades existentes

- Instalador/utilidades: `scripts/factory.py` (Python estándar).
- Agentes OpenCode: 7 (`build`, `architect`, `implementer`, `reviewer`, `tester`, `cloud-arbiter`, `reverse`).
- Comandos OpenCode: 5.
- Skills propias: 10, cada una con `SKILL.md`.
- Skill externa: `reverse-engineer-anything`, bajo `.agents/skills/`.
- Configuración central: `opencode.json`; MCP configurados: REA, Context7 y Playwright.
- Plantillas: `AGENTS.md` y calidad Java Maven/Gradle.
- El instalador conserva archivos del consumidor, detecta conflictos y mantiene manifiestos de reversión.

## Límites observados

- El repositorio es una fábrica instalable por CLI; no contiene todavía una aplicación web, API de orquestación ni persistencia de tareas.
- Los siete agentes fijan actualmente `opencode-go/mimo-v2.6-flash` en su frontmatter.
- `opencode.json` también declara ese modelo como predeterminado.
- `project-discovery/SKILL.md` incluye instrucciones específicas de herramientas de OpenCode; requiere adaptación por motor.
- Las definiciones de agente contienen frontmatter/permisos/herramientas propios de OpenCode; no deben copiarse literalmente a Claude Code.
- La Skill externa REA debe conservar su procedencia y verificarse por separado antes de habilitarla en cada motor.
- El README dice OpenCode v2.0.31; el binario local reporta v2.1.4. Claude Code local reporta v2.1.319.
- El ejecutable OpenCode está en `~/.opencode/bin/opencode`, directorio que no se incorpora al PATH de shells no interactivos.

## Verificaciones ejecutadas

| Comando | Resultado | Alcance |
|---|---|---|
| `python3 scripts/factory.py self-test` | PASS | Instalación, conflictos, preservación, reversión y plantillas en temporales |
| `python3 -m py_compile scripts/factory.py` | PASS | Sintaxis Python |
| `jq -e . opencode.json` | PASS | JSON válido |
| `bash scripts/verify-factory.sh` | PASS | Estructura, frontmatter, configuración/agentes OpenCode y self-test |

La batería estructural no ejecuta pruebas de una aplicación consumidora ni valida todavía comunicación real entre motores.

## Conclusión

Conservar la fábrica y añadirle una capa de control multi-motor. Mantener intactos los activos OpenCode existentes y construir adaptadores explícitos para Claude Code, con catálogo de modelos separado, permisos traducidos y Skills compartidas validadas.

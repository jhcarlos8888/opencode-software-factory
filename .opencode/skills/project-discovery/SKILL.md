---
name: project-discovery
description: Descubre y analiza un proyecto desconocido antes de modificarlo. Identifica estructura, dependencias, comandos reales, pruebas y estado de Git, respaldando las conclusiones con evidencia. Cárgala al comenzar a trabajar en un repositorio que no conoces.
---

# Descubrimiento de proyecto

## Objetivo

Comprender el proyecto real antes de proponer cambios. Cada conclusión importante debe poder rastrearse a un archivo leído o a una comprobación ejecutada.

## Procedimiento

1. **Instrucciones**: busca las instrucciones aplicables, como `AGENTS.md`, `README*`, `CONTRIBUTING*` y `docs/`. Si existen, léelos primero y respétalos.
2. **Identifica el stack con evidencia**: lee los manifiestos que REALMENTE existan en el proyecto. No busques archivos de un ecosistema en un proyecto de otro:
   - `package.json` / `bun.lock` / `pnpm-lock.yaml` → Node/TypeScript
   - `pom.xml` / `build.gradle` / `build.gradle.kts` / `settings.gradle` → Java/Kotlin
   - `pyproject.toml` / `requirements.txt` / `setup.py` → Python
   - `Cargo.toml` → Rust
   - `go.mod` → Go
   - `*.csproj` / `*.sln` → .NET
   - `Makefile` → build genérico
   Si la evidencia indica un proyecto Java con Gradle, no busques `package.json`.
3. **Encuentra los comandos reales**: lee la sección `scripts` de `package.json`, los perfiles de Maven/Gradle, los targets del `Makefile`, los tasks del `pyproject.toml`. Anota los comandos EXACTOS de build, test y lint.
4. **Mapea la estructura**: puntos de entrada (`main`, `index`, `app`), dónde vive el código, dónde están las pruebas (`test/`, `tests/`, `__tests__/`, `src/test/`, `*.test.*`, `*_test.*`, `*Test.java`).
5. **Comprueba el estado de Git**: `git status` y `git log --oneline -10` para saber si hay trabajo sin commitear que debas respetar.
6. **Busca código relacionado** con la tarea usando las herramientas de búsqueda disponibles (`glob`, `grep`). Cita rutas que hayas leído de verdad, no solo encontrado por nombre.

## Herramientas

Usa las herramientas DIRECTAS que OpenCode te expone: `read`, `glob`, `grep` y `shell`. No intentes invocarlas dentro de `execute` con nombres inventados como `tools.read` o `tools.glob`: dentro de `execute` solo existen las herramientas de su catálogo (context7, opencode, playwright). Si una herramienta no existe, dilo en vez de repetir la llamada.

## Entrega

Devuelve un resumen compacto:

- Lenguaje y framework (con el manifiesto que lo demuestra).
- Comandos exactos de build / test / lint (o `desconocido` si no los hay).
- Puntos de entrada y rutas clave.
- Pruebas existentes relevantes a la tarea.
- Estado de Git y riesgos evidentes.

## Reglas

- No inventes comandos ni rutas: si no los encontraste, escribe `desconocido`.
- No modifiques ningún archivo durante esta exploración.
- Si el proyecto tiene varias aplicaciones o paquetes, dilo y pregunta cuál es el alcance.

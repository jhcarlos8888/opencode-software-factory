---
name: project-discovery
description: Analiza un proyecto de programación desconocido antes de tocarlo: lenguaje, estructura, dependencias, comandos reales de build/test/lint y pruebas existentes. CÁRGALA al empezar a trabajar en un repositorio que no conoces o antes de proponer cambios en uno.
---

# Descubrimiento de proyecto

## Objetivo

Entender cómo funciona realmente un proyecto antes de modificarlo, para no suponer nada.

## Procedimiento

1. **Instrucciones del proyecto**: busca `AGENTS.md`, `README*`, `CONTRIBUTING*`, `docs/`. Si existen, léelos primero y respétalos.
2. **Identifica el stack**: lenguaje, framework y gestor de dependencias leyendo los archivos de manifiesto:
   - `package.json` / `bun.lock` / `pnpm-lock.yaml` → Node/TS
   - `pom.xml` / `build.gradle*` → Java/Kotlin
   - `pyproject.toml` / `requirements.txt` / `setup.py` → Python
   - `Cargo.toml` → Rust
   - `go.mod` → Go
   - `*.csproj` / `*.sln` → .NET
3. **Encuentra los comandos reales**: lee la sección `scripts` de `package.json`, los perfiles de Maven/Gradle, los targets del `Makefile`, los `tasks` del `pyproject.toml`. Anota los comandos EXACTOS de build, test y lint.
4. **Mapea la estructura**: puntos de entrada (`main`, `index`, `app`), dónde vive el código, dónde las pruebas (`test/`, `tests/`, `__tests__`, `*.test.*`, `*_test.*`).
5. **Comprueba el estado de Git**: `git status` y `git log --oneline -10` para saber si hay trabajo sin commitear que debas respetar.
6. **Busca código relacionado** con la tarea usando `glob` y `grep`. Cita rutas que hayas leído de verdad.

## Entrega

Devuelve un resumen compacto:

- Lenguaje y framework.
- Comandos exactos de build / test / lint (o `desconocido` si no los hay).
- Puntos de entrada y rutas clave.
- Pruebas existentes relevantes a la tarea.
- Estado de git y riesgos evidentes.

## Reglas

- No inventes comandos ni rutas: si no los encontraste, escribe `desconocido`.
- No modifiques ningún archivo durante esta exploración.
- Si el proyecto tiene varias aplicaciones o paquetes, dilo y pregunta cuál es el alcance.

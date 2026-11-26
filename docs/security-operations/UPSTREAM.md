# Procedencia de `security-audit` (capa local de integración)

Este documento es **propio de este repositorio**; no proviene de upstream.

## Procedencia

| Campo | Valor |
| --- | --- |
| Repositorio upstream | https://github.com/cloudflare/security-audit-skill |
| Commit exacto | `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8` |
| Fecha del commit (UTC) | 2026-09-14T19:28:54Z |
| Mensaje del commit | `Clarify guidance and full audit modes` |
| Tree SHA del commit | `8cd03bb3941496e441d6248aaae2429a35b93cc3` |
| Licencia | MIT (LICENSE de la raíz upstream, copiada sin alteraciones) |
| Ruta upstream | `skills/security-audit` |
| Destino local | `.opencode/skills/security-audit/` |
| Registro de integridad | `docs/security-operations/provenance.json` + `docs/security-operations/provenance.sha256` |

El tree SHA se obtuvo de la API de GitHub (`GET /repos/cloudflare/security-audit-skill/git/commits/<commit>`, campo `tree.sha`) y coincide con `git rev-parse <commit>^{tree}` sobre el clon temporal.

## Alcance de la copia

- Los 20 archivos que upstream tiene bajo `skills/security-audit` (SKILL.md, 14 documentos técnicos `*.md`, `report-schema.json`, `validate-findings.cjs` + su test, `validate-coverage-ledger.cjs` + su test).
- El `LICENSE` MIT de la raíz upstream, copiado como `.opencode/skills/security-audit/LICENSE`.
- Copia byte-idéntica: sin edición de contenido, sin wrapper `SKILL.md`, sin tocar frontmatter, con el bit ejecutable conservado en `validate-findings.cjs` y `validate-coverage-ledger.cjs` (modo git `100755`).
- No se importan `README.md` ni ningún otro archivo fuera de esas dos rutas. No se borró ningún archivo preexistente (el destino no existía antes de la importación).
- La importación se hizo desde un clon temporal bajo `/tmp/opencode` fijado en detached HEAD sobre el commit exacto (sin rama flotante).

## Verificación segura

Desde la raíz del repositorio:

```sh
sha256sum -c docs/security-operations/provenance.sha256
```

Comprueba los SHA-256 de los 21 archivos importados más `provenance.json` contra el manifiesto. Para comprobar además la procedencia frente a upstream:

```sh
git -C /tmp/opencode/security-audit-import rev-parse HEAD   # debe ser c1c8a8c1471069fb0e188eeaff69b8e8db6564a8
diff -r --exclude=LICENSE \
  /tmp/opencode/security-audit-import/skills/security-audit \
  .opencode/skills/security-audit
cmp /tmp/opencode/security-audit-import/LICENSE .opencode/skills/security-audit/LICENSE
```

`diff -r` debe terminar sin salida (los 20 archivos de la skill coinciden) y `cmp` sin salida (la LICENSE coincide); ambos sin cambios = idénticos byte a byte.

Las suites oficiales de la skill se ejecutan con (no son código de un proyecto auditado):

```sh
node --test .opencode/skills/security-audit/validate-findings.test.cjs
node --test .opencode/skills/security-audit/validate-coverage-ledger.test.cjs
```

## Procedimiento de actualización

1. Detenerse: ninguna actualización automática. Todo cambio requiere un commit upstream **nuevo** (nunca mover un destino ya importado sin revisión) y una revisión explícita.
2. Clonar en un directorio temporal nuevo bajo `/tmp/opencode` y fijar detached HEAD en el commit upstream elegido; verificar `git rev-parse HEAD` contra el SHA anunciado.
3. Revisar el diff upstream (`git diff <commit-actual>..<commit-nuevo> -- skills/security-audit LICENSE`) y justificar el cambio.
4. Copiar de nuevo los archivos al destino conservando bytes y permisos, sobrescribiendo solo lo que el diff aprobado contemple.
5. Recalcular SHA-256 de todos los archivos, actualizar `provenance.json` (`sourceCommit`, `importedAt`, `sourceTreeSha`, `files`) y regenerar `provenance.sha256`.
6. Ejecutar `sha256sum -c docs/security-operations/provenance.sha256`, las dos suites oficiales con `node --test` y `git diff --check`.
7. Registrar en la revisión el commit upstream nuevo, el diff revisado y la salida real de los comandos; hacer commit solo tras aprobación.

Este documento no afirma resultados de pruebas; los resultados reales se registran en el informe de ejecución que acompañó a la importación.

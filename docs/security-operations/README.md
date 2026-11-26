# Security Operations (auditoría de ciberseguridad)

Documentación propia de este repositorio; la skill upstream importada vive en
`.opencode/skills/security-audit/` y su procedencia en `UPSTREAM.md`.

## Índice

| Documento | Contenido |
| --- | --- |
| `README.md` | Índice, origen/integridad y cómo verificar. |
| `ARCHITECTURE.md` | Arquitectura: fases, roles, perfiles, presupuesto, persistencia, artefactos, permisos, sandbox y límites. |
| `USER-GUIDE.md` | Guía de uso desde Control Center, por API y con el comando `/auditoria-seguridad`. |
| `MCP-CODEMODE.md` | Causa raíz del launcher MCP del filesystem (codemode, entorno y override retirado). |
| `INTEGRATION.md` | Puntos de integración, remediación, actualización upstream y trabajo pendiente. |
| `UPSTREAM.md` | Procedencia exacta, commit, manifiesto SHA-256 y procedimiento de actualización. |

## Origen e integridad

- Repositorio upstream: `https://github.com/cloudflare/security-audit-skill`.
- Commit importado: `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8` (ver `UPSTREAM.md`).
- Copia byte-idéntica en `.opencode/skills/security-audit/` (21 ficheros: SKILL.md,
  14 documentos técnicos, `report-schema.json`, los dos validadores con sus
  tests y la LICENSE MIT).
- Registro de integridad: `docs/security-operations/provenance.json` +
  `provenance.sha256`.

## Verificación

Desde la raíz del repositorio:

```sh
sha256sum -c docs/security-operations/provenance.sha256
node --test .opencode/skills/security-audit/validate-findings.test.cjs
node --test .opencode/skills/security-audit/validate-coverage-ledger.test.cjs
bash scripts/verify-factory.sh
```

`scripts/verify-factory.sh` exige la skill `security-audit`, la existencia de
los validadores, el esquema y la LICENSE, verifica `provenance.sha256` y
ejecuta las dos suites oficiales.

## Estado y límites

- La modalidad está implementada en el Control Center (API, planner, UI) pero
  **todavía no se ha ejecutado una auditoría end-to-end con motores de pago
  reales**; las pruebas cubren el orquestador con un invoker de pruebas y el
  adaptador productivo mediante revisión de contrato.
- La política por defecto es `source-only`: sin ejecución de código del target.
- El uso total de disco y la promoción de artefactos por dirfd no pueden
  garantizarse con las herramientas actuales (ver `ARCHITECTURE.md`).

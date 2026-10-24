---
description: Revisa el diff actual en busca de defectos demostrables sin modificar nada (subagente reviewer, solo lectura)
agent: reviewer
---

Revisa el siguiente cambio en busca de defectos demostrables. Examina el código real, no solo la descripción. Distingue defectos demostrables de sospechas y no reportes preferencias de estilo. Tu permiso de edición está denegado: reporta, no corrijas.

Estado y diff real del repositorio:

!`git status --short && echo "--- DIFF ---" && git diff HEAD`

Requisito o contexto:

$ARGUMENTS

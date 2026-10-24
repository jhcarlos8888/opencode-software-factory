---
name: independent-review
description: Revisa de forma independiente los cambios de código antes de darlos por terminado, buscando defectos demostrables sin modificar nada. CÁRGALA tras implementar cualquier cambio no trivial y antes de entregar el trabajo.
---

# Revisión independiente

## Objetivo

Contrastar el trabajo hecho por un agente con una revisión que no comparte sus supuestos, antes de declararlo terminado.

## Cuándo usarla

- Tras una implementación no trivial (más de un archivo, lógica nueva, cambio de contrato).
- Antes de decir que algo funciona.
- Cuando haya discrepancia entre lo que el implementador afirma y lo que muestran las pruebas.

## Procedimiento

1. **Consolidar evidencia primero**: pide al agente `tester` que ejecute build y tests, y conserva la salida real. Una opinión sin ejecución no vale.
2. **Obtener el diff real**: `git diff` (y `git diff --staged` si aplica). Revisa lo que cambió, no lo que se dijo que cambió.
3. **Lanzar al `reviewer`** con el diff y el requisito original, sin incluir el razonamiento privado del implementador (para que la revisión sea independiente de verdad).
4. **Clasificar los hallazgos**:
   - **Demostrable** → corregir (vuelve al implementador).
   - **Sospecha** → marcarla como sospecha y, si bloquea, verificarla con un comando.
   - **Preferencia de estilo** → descartarla.
5. **Repetir el ciclo** hasta que no queden defectos demostrables o hasta **3 ciclos**.

## Reglas de independencia

- El revisor no debe recibir las conclusiones del implementador, solo el diff, el requisito y las salidas de prueba.
- Si implementador y revisor discrepan, pide evidencia adicional o escala a `cloud-arbiter`.
- Nunca aceptes "ya lo revisé y está bien" sin un hallazgo concreto o una lista explícita de qué se comprobó.
- Que un modelo diga que el código está correcto **no** lo demuestra: lo demuestran las pruebas ejecutadas.

## Informe final

Hallazgos con severidad · qué se corrigió · comandos ejecutados con su resultado real · qué queda pendiente.

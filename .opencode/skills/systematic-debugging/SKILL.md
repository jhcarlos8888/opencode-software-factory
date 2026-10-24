---
name: systematic-debugging
description: Diagnostica y corrige errores reproducibles en cualquier lenguaje mediante evidencia, hipótesis y pruebas, sin ocultar síntomas. CÁRGALA cuando haya un fallo, una excepción, un resultado inesperado o un test que falla.
---

# Depuración sistemática

## Objetivo

Encontrar y corregir la causa raíz de un fallo sin introducir regresiones.

## Procedimiento

1. **Reproduce el fallo** antes de modificar el código. Si no se puede reproducir, no lo toques todavía.
2. **Conserva la evidencia**: mensaje de error completo, entrada que lo provoca y resultado esperado.
3. **Inspecciona el flujo**: sigue la ejecución real con `grep`/`read` por las rutas implicadas y sus dependencias. No adivines la pila de llamadas.
4. **Formula UNA hipótesis concreta** y busca evidencia que la confirme o refute.
5. **Diseña una prueba que falle** con el defecto original (o identifica la prueba existente que lo cubre).
6. **Aplica el cambio mínimo** que corrige la causa raíz.
7. **Ejecuta primero la prueba específica**, después las pruebas relevantes, al final la batería completa si es viable.
8. **Inspecciona tu diff** con `git diff` para detectar cambios colaterales no deseados.
9. **Si el fallo persiste**, revisa la hipótesis en vez de repetir el mismo parche.

## Restricciones

- No desactives pruebas para conseguir un resultado verde.
- No inventes resultados de compilación: ejecuta el comando y conserva la salida.
- No cambies contratos públicos sin justificarlo explícitamente.
- No ocultes fallos preexistentes: sepáralos de los que introdujiste tú.
- No cambies varios factores a la vez: si el fallo desaparece, no sabrás por qué.
- **Detente** si tras 3 intentos no avanzas con evidencia; reporta qué probaste y qué falta.

## Informe final

Causa raíz · archivos afectados · pruebas ejecutadas · resultados reales · riesgos pendientes.

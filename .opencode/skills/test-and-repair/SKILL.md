---
name: test-and-repair
description: Ejecuta build, tests y análisis estático, interpreta los fallos reales y corrige hasta que pasen o hasta agotar el límite de intentos. CÁRGALA cuando build o tests fallen tras un cambio, o antes de declar terminado un trabajo.
---

# Autocorrección con verificación

## Objetivo

Cerrar el ciclo **ejecutar → leer fallo → corregir → volver a ejecutar** con evidencia, sin declarar victoria prematura.

## Cuándo usar esta skill

- **Frente a `systematic-debugging`**: es su **complemento**. Esta skill
  repara el **build/test global** del proyecto (itera sobre la batería
  completa hasta el verde o hasta agotar intentos);
  `systematic-debugging` diagnostica **un fallo concreto y reproducible**
  hasta la causa raíz con hipótesis y una prueba que falle.
- Regla práctica: si el proyecto **no compila o la batería está roja**, usa
  esta; si al aislar queda **un fallo concreto** que resiste un par de
  iteraciones, delega ese caso en `systematic-debugging` y vuelve aquí para
  re-ejecutar la batería.

## Ciclo

1. **Detecta las herramientas reales** del proyecto (no inventes comandos): lee `package.json`, `pom.xml`, `pyproject.toml`, `Makefile`, etc.
2. **Ejecuta la verificación más rápida primero** (compilación/typecheck), después los tests, al final lint/estática si están disponibles.
3. **Interpreta cada fallo**:
   - ¿Es un error **mío** (nuevo)? → corríjelo.
   - ¿Es un fallo **preexistente**? → sepáralo y repórtalo; no lo ocultes ni lo atribuyas a tu cambio.
   - ¿Es **ruido** (log irrelevante)? → recórtalo y busca la causa real.
4. **Transforma el fallo en una tarea concreta**: archivo, línea, qué esperaba, qué ocurrió.
5. **Corrige el cambio mínimo** y **vuelve al paso 2**.
6. **Termina** cuando las verificaciones pasen o cuando se agote el límite de intentos.

## Límite de intentos

- **3 intentos** por defecto sobre el mismo fallo.
- Si el intento N produce exactamente el mismo error que el N-1, **no repitas la misma corrección**: cambia de hipótesis o escala.
- Al agotar los intentos, detente y reporta en lugar de seguir parcheando.

## Escalado

Cuando los intentos locales fallen y haya dos hipótesis en conflicto, solicita al agente `cloud-arbiter` que decida con la evidencia disponible. No escales por defecto: solo con discrepancia real o fallo resistente.

## Informe final

- **Qué se corrigió** y por qué era la causa raíz.
- **Comandos ejecutados** y su salida real (nunca un "debería pasar").
- **Resultado real**: tests pasados / fallidos / no ejecutados, con números.
- **Pendiente**: qué no se pudo verificar y por qué.

## Reglas duras

- Nunca declares una verificación satisfactoria sin haber ejecutado el comando.
- Nunca modifiques o desactives una prueba para que pase.
- Nunca entregues "todo verde" si algún comando falló o no se ejecutó.

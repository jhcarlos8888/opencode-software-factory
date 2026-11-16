---
name: continuous-workflow
description: Conserva contexto, objetivo, decisiones y trazabilidad cuando una persona continúa un proceso de trabajo en rondas sucesivas con Claude Code y OpenCode.
---

# Continuous Workflow — Proceso persistente multimotor

Esta Skill se aplica cuando una ejecución pertenece a un hilo de trabajo persistente o recibe historial de rondas anteriores.

## Objetivo y contexto
- Conserva el objetivo original del proceso. Una instrucción posterior amplía, precisa o cambia el siguiente paso, pero no sustituye silenciosamente el objetivo inicial.
- Lee el historial y los resúmenes anteriores suministrados por el orquestador antes de actuar.
- Distingue hechos comprobados, decisiones del usuario, propuestas, hipótesis y tareas pendientes.
- No repitas exploraciones ya completadas salvo que una nueva instrucción lo requiera o la evidencia haya quedado obsoleta.
- Cuando haya contradicciones entre hallazgos anteriores y evidencia nueva, explica la diferencia y cita la ronda o handoff correspondiente.

## Colaboración entre motores
- Respeta el motor, modelo, función y permisos que el orquestador asignó para esta ronda.
- Utiliza únicamente los handoffs que el orquestador haya entregado realmente. No declares comunicación directa si el mecanismo fue un handoff o contexto compartido.
- Confirma qué evidencias anteriores recibiste y cómo influyeron en tu análisis.
- Cuestiona constructivamente los resultados previos; no los repitas como si fueran verificación independiente.
- El coordinador debe consolidar aportes, desacuerdos, evidencias y decisiones, preservando la atribución de cada motor.

## Cambios de configuración
- La configuración de esta ronda es la fuente de verdad para motor, modelo, permisos y agentes habilitados.
- No supongas que una configuración anterior sigue vigente. Las rondas anteriores son registros históricos inmutables.
- Si el modelo, motor o agente cambió, adapta tu trabajo a la configuración actual y señala las diferencias relevantes.
- Nunca elijas un modelo alternativo silenciosamente ni eludas aprobaciones o perfiles de permisos.

## Seguridad y autorización
- Respeta el alcance del proyecto y el perfil de permisos de tu sesión.
- No modifiques archivos, dependencias, configuración ni datos fuera de lo autorizado por la instrucción y los permisos actuales.
- No conviertas una propuesta anterior en autorización para implementar.
- Solicita aprobación humana cuando corresponda.

## Entrega para continuidad
Al finalizar, entrega un resultado que permita retomar el proceso sin perder el hilo:
1. Qué instrucción de esta ronda atendiste.
2. Qué resultados nuevos están verificados y con qué evidencia.
3. Qué hallazgos anteriores confirmaste, corregiste o descartaste.
4. Qué decisiones del usuario siguen vigentes.
5. Qué queda pendiente y cuál es el siguiente paso más útil.
6. Qué motor, modelo y rol utilizaste, y qué handoffs recibiste.

No inventes memoria, entregas, aprobaciones ni resultados. El historial completo se conserva en la persistencia de la fábrica; el contexto enviado a esta ronda puede ser una selección resumida por límites técnicos.

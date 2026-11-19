import assert from "node:assert/strict";
import { test } from "node:test";
import { planTask, recommendProjectTeam, resolveAgentPermissionProfile, selectAgentsForTask } from "./task-planner.js";

test("project-only team recommendation does not require a task instruction", () => {
  const recommendation = recommendProjectTeam({
    complexity: "low",
    stackCount: 1,
    moduleCount: 0,
    manifestCount: 1
  }, "focused");

  assert.deepEqual(recommendation.recommendedAgents, [
    "architect", "build", "implementer", "reviewer", "cloud-arbiter"
  ]);
  assert.equal(recommendation.depth, "focused");
  assert.ok(recommendation.reasons.length > 0);
});

test("multi-module projects receive a larger team and deep project coverage", () => {
  const recommendation = recommendProjectTeam({
    complexity: "high",
    stackCount: 3,
    moduleCount: 12,
    manifestCount: 15
  }, "deep");

  assert.equal(recommendation.recommendedAgents.length, 7);
  assert.ok(recommendation.recommendedAgents.includes("tester"));
  assert.ok(recommendation.recommendedAgents.includes("reverse"));
  assert.match(recommendation.reasons.join(" "), /módulos|multidisciplinario/i);
});

test("changing preflight depth changes the project exploration profile without changing task classification", () => {
  const quick = recommendProjectTeam({ complexity: "medium", stackCount: 1, moduleCount: 2, manifestCount: 2 }, "quick");
  const deep = recommendProjectTeam({ complexity: "medium", stackCount: 1, moduleCount: 2, manifestCount: 2 }, "deep");

  assert.deepEqual(quick.recommendedAgents, deep.recommendedAgents);
  assert.notEqual(quick.depth, deep.depth);

  const firstTask = planTask("Implementa pruebas unitarias para el servicio de pólizas.");
  const secondTask = planTask("Investiga por qué falla la autenticación.");
  assert.equal(firstTask.kind, "implementation");
  assert.equal(secondTask.kind, "diagnosis");
});

test("project architecture and size, rather than a future task, determine the recommended specialist set", () => {
  const small = recommendProjectTeam({ complexity: "low", stackCount: 1, moduleCount: 0, manifestCount: 1 }, "quick");
  const large = recommendProjectTeam({ complexity: "very-high", stackCount: 4, moduleCount: 10, manifestCount: 12 }, "quick");
  assert.ok(large.recommendedAgents.length > small.recommendedAgents.length);
});


test("task routing selects only the specialists recommended for the actual task", () => {
  const assignments = [
    "architect", "build", "implementer", "reviewer", "tester", "reverse", "cloud-arbiter"
  ].map((agentId) => ({ agentId, enabled: true }));
  const plan = planTask("¿Me puedes indicar de qué trata este proyecto?");
  const selection = selectAgentsForTask(assignments, plan);

  assert.deepEqual(plan.recommendedAgents, ["architect"]);
  assert.deepEqual(selection.selectedAgentIds, ["architect"]);
  assert.deepEqual(selection.skippedAgentIds, ["build", "implementer", "reviewer", "tester", "reverse", "cloud-arbiter"]);
  assert.deepEqual(selection.unavailableRequiredAgentIds, []);
});

test("task routing does not silently re-enable a required specialist disabled by the user", () => {
  const assignments = [
    { agentId: "architect", enabled: true },
    { agentId: "tester", enabled: false },
    { agentId: "build", enabled: true },
    { agentId: "cloud-arbiter", enabled: true }
  ];
  const plan = planTask("Ejecuta pruebas unitarias y valida la cobertura.");
  const selection = selectAgentsForTask(assignments, plan);

  assert.deepEqual(selection.selectedAgentIds, ["build"]);
  assert.ok(selection.unavailableRequiredAgentIds.includes("tester"));
  assert.ok(selection.skippedAgentIds.includes("architect"));
  assert.ok(!selection.selectedAgentIds.includes("tester"));
});

test("Cloud Arbiter is not silently added to a simple explanation task", () => {
  const selection = selectAgentsForTask([
    { agentId: "architect", enabled: true },
    { agentId: "build", enabled: true },
    { agentId: "cloud-arbiter", enabled: true }
  ], { recommendedAgents: ["architect"] });

  assert.deepEqual(selection.selectedAgentIds, ["architect"]);
  assert.deepEqual(selection.skippedAgentIds, ["build", "cloud-arbiter"]);
  assert.deepEqual(selection.mandatoryAgentIds, []);
  assert.deepEqual(selection.unavailableRequiredAgentIds, []);
});

test("follow-up requests to apply suggested corrections are classified as implementation work", () => {
  const plan = planTask("Sigue con las correcciones sugeridas sin dañar la lógica actual, mejorando el proceso.");
  assert.equal(plan.kind, "implementation");
  assert.equal(plan.changesExpected, true);
  assert.ok(plan.recommendedAgents.includes("implementer"));
  assert.ok(plan.recommendedAgents.includes("reviewer"));
  assert.ok(plan.recommendedAgents.includes("tester"));
});

test("automatic permissions grant workspace writes only to Implementer for implementation tasks", () => {
  const plan = planTask("Implementa la corrección del exportador y agrega una prueba de regresión.");
  assert.equal(resolveAgentPermissionProfile("implementer", plan, "automatic", "read-only").permissionProfile, "workspace-write");
  assert.equal(resolveAgentPermissionProfile("tester", plan, "automatic", "read-only").permissionProfile, "approval-required");
  assert.equal(resolveAgentPermissionProfile("reviewer", plan, "automatic", "workspace-write").permissionProfile, "read-only");
  assert.equal(resolveAgentPermissionProfile("cloud-arbiter", plan, "automatic", "workspace-write").permissionProfile, "read-only");
});

test("manual permission profiles override automatic task resolution", () => {
  const implementation = planTask("Realiza las correcciones solicitadas.");
  const explanation = planTask("Explica de qué trata este proyecto.");
  assert.equal(resolveAgentPermissionProfile("implementer", implementation, "manual", "read-only").permissionProfile, "read-only");
  assert.equal(resolveAgentPermissionProfile("reviewer", implementation, "manual", "workspace-write").permissionProfile, "workspace-write");
  assert.equal(resolveAgentPermissionProfile("implementer", explanation, "automatic", "workspace-write").permissionProfile, "read-only");
});

test("Cloud Arbiter participates when the task plan explicitly recommends it", () => {
  const assignments = [
    { agentId: "architect", enabled: true },
    { agentId: "implementer", enabled: true },
    { agentId: "reviewer", enabled: true },
    { agentId: "tester", enabled: true },
    { agentId: "build", enabled: true },
    { agentId: "cloud-arbiter", enabled: true }
  ];
  const plan = planTask("Implementa una nueva función y sus pruebas.");
  assert.ok(plan.recommendedAgents.includes("cloud-arbiter"));
  assert.deepEqual(selectAgentsForTask(assignments, plan).selectedAgentIds, plan.recommendedAgents);
});

test("round 5 mixed verification, startup and Git request selects executor and tester", () => {
  const plan = planTask("Bueno entonces hagamos las siguientes tareas, levantemos el proyecto y verifiquemos que efectivamente todos los agentes tengan bien configurado los modelos solicitados y que respondan. Hagamos commit y push luego de verificar que todo funciona.");
  assert.equal(plan.kind, "implementation");
  assert.equal(plan.changesExpected, true);
  assert.ok(plan.recommendedAgents.includes("implementer"));
  assert.ok(plan.recommendedAgents.includes("tester"));
  assert.ok(plan.recommendedAgents.includes("build"));
  assert.equal(resolveAgentPermissionProfile("implementer", plan, "automatic", "read-only").permissionProfile, "workspace-write");
});

test("read-only verification of all agents remains a testing task", () => {
  const plan = planTask("Verifica que todos los agentes tengan bien configurados los modelos. Sin modificar archivos.");
  assert.equal(plan.kind, "testing");
  assert.equal(plan.changesExpected, false);
});


test("round 1 Aula typography request routes natural Spanish to implementation", () => {
  const exact = "Hola que tal todo ? quisiera me colabores aumentando el tamaño de la letra del proyecto en general de aula research";
  const plan = planTask(exact);
  assert.equal(plan.kind, "implementation");
  assert.equal(plan.changesExpected, true);
  for (const agent of ["architect", "implementer", "tester", "reviewer", "cloud-arbiter"]) {
    assert.ok(plan.recommendedAgents.includes(agent), agent);
  }
  assert.equal(resolveAgentPermissionProfile("implementer", plan, "automatic", "read-only").permissionProfile, "workspace-write");
});

test("polite, colloquial, infinitive and outcome-oriented UI requests are actionable", () => {
  const requests = [
    "Me ayudas a aumentar el tamaño de letra en todas las pantallas?",
    "Quisiera que me colabores agrandando los textos de los formularios.",
    "Por favor puedes ampliar la fuente del editor?",
    "Necesito reducir los márgenes de la aplicación.",
    "Me gustaría que los botones fueran más grandes.",
    "Que la letra de la interfaz se vea más grande.",
    "Podrías cambiar el color del menú?",
    "Hagamos la fuente más legible para usuarios mayores.",
    "Quiero ajustar el espaciado de los encabezados.",
    "Baja el tamaño de los iconos y sube el de los títulos.",
    "Aumenta la tipografía sin cambiar el formato APA del Word."
  ];
  for (const request of requests) {
    const plan = planTask(request);
    assert.equal(plan.kind, "implementation", request);
    assert.ok(plan.recommendedAgents.includes("implementer"), request);
  }
});

test("questions about doing the work do not authorize changes", () => {
  const informational = [
    "Cómo puedo aumentar la letra de la aplicación?",
    "¿Puedes explicar cómo cambiar la fuente del proyecto?",
    "Quiero saber por qué reducir los márgenes podría romper la interfaz.",
    "Qué debo hacer para agrandar la letra del editor?",
    "Explica las ventajas de modificar los estilos.",
    "No aumentes las fuentes, solo analiza los estilos.",
    "Verifica las fuentes, sin modificar la interfaz.",
    "No cambies los estilos CSS, solo revisa accesibilidad."
  ];
  for (const request of informational) {
    const plan = planTask(request);
    assert.notEqual(plan.kind, "implementation", request);
    assert.equal(plan.changesExpected, false, request);
    assert.ok(!plan.recommendedAgents.includes("implementer"), request);
  }
});

test("explicitly requested changes remain actionable beside negative constraints", () => {
  for (const request of [
    "No cambies las fuentes APA del Word. Aumenta la fuente en la interfaz.",
    "Explica los riesgos y luego implementa una fuente más grande.",
    "Sin modificar los datos de usuarios, agranda las etiquetas de la pantalla."
  ]) {
    const plan = planTask(request);
    assert.equal(plan.kind, "implementation", request);
  }
});

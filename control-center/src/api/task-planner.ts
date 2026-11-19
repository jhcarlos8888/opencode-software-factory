export type TaskKind = "explanation" | "diagnosis" | "implementation" | "testing" | "architecture-review" | "general";
export type ResearchDepth = "quick" | "focused" | "deep";
export type TaskPermissionProfile = "read-only" | "workspace-write" | "approval-required";
export type TaskPermissionMode = "automatic" | "manual";
export interface TaskPlan {
  kind: TaskKind;
  complexity: "low" | "medium" | "high";
  depth: ResearchDepth;
  recommendedAgents: string[];
  reasons: string[];
  changesExpected: boolean;
}
function normalize(value: string): string {
  return value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
/** Classifies requested work independently from repository size/complexity. */
export function planTask(instructions: string, depthOverride?: ResearchDepth): TaskPlan {
  const text = normalize(instructions);
  const broadScope = /todo el proyecto|proyecto completo|de extremo a extremo|integral|todos los modulos|toda la arquitectura|redisenar|migracion completa|auditoria completa/.test(text);
  const explicitDeep = /auditoria|audita|diseno arquitectonico|investigacion profunda|comparativa|analisis exhaustivo|seguridad|rendimiento|performance/.test(text);
  const asksArchitectureReview = /analiza.*arquitectura|revisa.*arquitectura|evaluacion.*arquitectura|arquitectura.*actual/.test(text);
  const explicitChangeVerb = /implementa|implementar|crea|crear|agrega|anade|modifica|modificar|corrige|corregir|refactor|migra|migrar|actualiza|actualizar|desarrolla|desarrollar|mejora|mejorar/.test(text);
  const followUpChangeRequest = /(?:sigue|seguir|continua|continuar|aplica|aplicar|realiza|realice|realizar|haz|hacer|hagamos|efectua|efectuar|ejecuta|ejecutar).{0,70}(?:correcciones?|arreglos?|mejoras?|cambios?|ajustes?)/.test(text);
  const asksForChange = explicitChangeVerb || followUpChangeRequest;
  const asksForTests = /prueba|pruebas|test|testing|validar|valida|verifica|verificacion|cobertura/.test(text);
  const asksForDiagnosis = /error|falla|fallo|bug|problema|no funciona|investiga|diagnostica|causa|por que/.test(text);
  const asksForExplanation = /explica|explicame|de que trata|que hace|describe|resumen|resume|en un parrafo|overview/.test(text);
  const asksForReverse = /ingenieria inversa|descompil|desensambl|binario|\.dll|\.exe|\.so|\.class|\bjar\b/.test(text);
  let kind: TaskKind = "general";
  let agents = ["architect"];
  let depth: ResearchDepth = "focused";
  let complexity: TaskPlan["complexity"] = "medium";
  let changesExpected = false;
  const reasons: string[] = [];
  if (asksForChange) {
    kind = "implementation"; changesExpected = true;
    agents = broadScope || explicitDeep
      ? ["architect", "implementer", "reviewer", "tester", "build", "cloud-arbiter"]
      : ["architect", "implementer", "reviewer", "tester", "cloud-arbiter"];
    if (asksForTests) agents = [...new Set([...agents, "tester", "build"])];
    depth = broadScope || explicitDeep ? "deep" : "focused";
    complexity = broadScope || explicitDeep ? "high" : "medium";
    reasons.push("La instruccion solicita cambios en el codigo.");
  } else if (asksForTests) {
    kind = "testing"; agents = ["tester", "build"]; depth = "focused"; complexity = "medium";
    reasons.push("La instruccion solicita validacion o pruebas.");
  } else if (asksForDiagnosis) {
    kind = "diagnosis"; agents = ["architect", "reviewer"];
    depth = explicitDeep || broadScope ? "deep" : "focused";
    complexity = explicitDeep || broadScope ? "high" : "medium";
    reasons.push("La instruccion busca identificar una causa o investigar un problema.");
    reasons.push("Se mantiene en solo lectura porque no se solicitaron cambios.");
  } else if (asksForExplanation && !explicitDeep) {
    kind = "explanation"; agents = ["architect"]; depth = "quick"; complexity = "low";
    reasons.push("La instruccion solicita una explicacion o resumen, no una modificacion.");
    reasons.push("Basta una exploracion documental y de archivos representativos.");
  } else if (explicitDeep || broadScope || asksArchitectureReview) {
    kind = "architecture-review"; agents = ["architect", "reviewer", "tester", "cloud-arbiter"];
    if (asksForReverse) agents.push("reverse");
    depth = "deep"; complexity = "high";
    reasons.push("El objetivo requiere una revision amplia o especializada.");
    reasons.push("Se seleccionan especialistas de lectura y validacion; no se habilitan cambios.");
  } else {
    reasons.push("No se detecto una accion especifica; se propone una exploracion focalizada con el Arquitecto.");
  }
  if (asksForReverse && !agents.includes("reverse")) {
    agents.push("reverse"); depth = "deep"; complexity = "high";
    reasons.push("Se detectaron referencias explicitas a binarios o ingenieria inversa.");
  }
  if (broadScope) reasons.push("El alcance declarado abarca multiples modulos o el proyecto completo.");
  const selectedDepth = depthOverride ?? depth;
  return { kind, complexity, depth: selectedDepth, recommendedAgents: agents, reasons, changesExpected };
}


export interface ProjectTeamRecommendation {
  depth: ResearchDepth;
  recommendedAgents: string[];
  reasons: string[];
}

/**
 * Selects a baseline team from project evidence only.
 * It deliberately does not inspect a user task: the user supplies that later
 * through the work conversation, where planTask() classifies the real request.
 */
export function recommendProjectTeam(
  project: {
    complexity: "low" | "medium" | "high" | "very-high";
    stackCount: number;
    moduleCount: number;
    manifestCount: number;
  },
  depth: ResearchDepth
): ProjectTeamRecommendation {
  const reasons: string[] = [];
  let tier: "low" | "medium" | "high" = project.complexity === "very-high"
    ? "high"
    : project.complexity;

  if (project.stackCount > 1 || project.manifestCount > 2 || project.moduleCount >= 4) {
    if (tier === "low") tier = "medium";
    reasons.push("La arquitectura presenta varios stacks, manifiestos o módulos que requieren coordinación.");
  }
  if (project.moduleCount >= 8 || project.stackCount >= 4 || project.complexity === "very-high") {
    tier = "high";
    reasons.push("El volumen o la distribución modular justifican un equipo multidisciplinario completo.");
  }

  const recommendedAgents = ["architect", "build", "implementer", "reviewer", "cloud-arbiter"];
  if (tier !== "low") {
    recommendedAgents.push("tester");
    reasons.push("Se incorpora QA/Tester para validar módulos y dependencias del proyecto.");
  }
  if (tier === "high") {
    recommendedAgents.push("reverse");
    reasons.push("Se incorpora Reverse para apoyar el análisis especializado de componentes y dependencias complejas.");
  }
  if (reasons.length === 0) {
    reasons.push("El tamaño y la arquitectura permiten comenzar con un equipo base, sin activar especialistas adicionales de forma preventiva.");
  }
  reasons.push(
    depth === "quick"
      ? "La preconsulta rápida limita el recorrido estructural y prioriza los indicadores principales."
      : depth === "deep"
        ? "La preconsulta profunda amplía el recorrido de carpetas y la detección de módulos para reducir puntos ciegos."
        : "La preconsulta focalizada equilibra cobertura estructural y velocidad."
  );

  return { depth, recommendedAgents, reasons };
}

/**
 * Resolves effective permissions per task without mutating the saved team
 * configuration. Automatic mode grants workspace writes only to Implementer
 * when the task plan explicitly expects changes. Tester keeps human approval
 * for commands; analysis and arbitration roles remain read-only.
 */
export function resolveAgentPermissionProfile(
  agentId: string,
  taskPlan: Pick<TaskPlan, "kind" | "changesExpected">,
  permissionMode: TaskPermissionMode,
  configuredProfile: TaskPermissionProfile
): { permissionProfile: TaskPermissionProfile; reason: string } {
  if (permissionMode === "manual") {
    return {
      permissionProfile: configuredProfile,
      reason: "Perfil fijado manualmente en la configuración del equipo."
    };
  }

  if (agentId === "implementer" && taskPlan.changesExpected) {
    return {
      permissionProfile: "workspace-write",
      reason: "La tarea solicita cambios; Implementer recibe escritura limitada al workspace."
    };
  }

  if (agentId === "tester" && (taskPlan.kind === "testing" || taskPlan.changesExpected)) {
    return {
      permissionProfile: "approval-required",
      reason: "Tester conserva aprobación humana para ejecutar comandos y operaciones protegidas."
    };
  }

  return {
    permissionProfile: "read-only",
    reason: taskPlan.changesExpected
      ? "Este rol analiza o revisa; no necesita modificar el proyecto."
      : "La tarea no solicita modificaciones; se conserva solo lectura."
  };
}

export interface TaskAgentAvailability {
  agentId: string;
  enabled: boolean;
}

export interface TaskAgentSelection {
  selectedAgentIds: string[];
  skippedAgentIds: string[];
  unavailableRequiredAgentIds: string[];
  mandatoryAgentIds: string[];
}

/**
 * Converts a task plan into the actual roster for an execution.
 * The task plan is the source of truth for the roster. There are no hidden
 * always-on agents: cross-engine arbitration must be recommended explicitly.
 * The plan never mutates saved assignments. Required agents that are disabled
 * remain disabled and block the run with an actionable message at admission.
 */
export function selectAgentsForTask(
  assignments: TaskAgentAvailability[],
  taskPlan: Pick<TaskPlan, "recommendedAgents">,
  mandatoryAgentIds: string[] = []
): TaskAgentSelection {
  const required = [...new Set([...taskPlan.recommendedAgents, ...mandatoryAgentIds])];
  const assignmentById = new Map(assignments.map((assignment) => [assignment.agentId, assignment]));
  const unavailableRequiredAgentIds = required.filter((agentId) => !assignmentById.get(agentId)?.enabled);
  const selectedAgentIds = required.filter((agentId) => assignmentById.get(agentId)?.enabled);
  const selectedSet = new Set(selectedAgentIds);
  const skippedAgentIds = assignments
    .filter((assignment) => assignment.enabled && !selectedSet.has(assignment.agentId))
    .map((assignment) => assignment.agentId);
  return {
    selectedAgentIds,
    skippedAgentIds,
    unavailableRequiredAgentIds,
    mandatoryAgentIds: [...new Set(mandatoryAgentIds)]
  };
}

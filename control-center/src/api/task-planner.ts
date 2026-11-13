export type TaskKind = "explanation" | "diagnosis" | "implementation" | "testing" | "architecture-review" | "general";
export type ResearchDepth = "quick" | "focused" | "deep";
export interface TaskPlan {
  kind: TaskKind;
  complexity: "low" | "medium" | "high";
  depth: ResearchDepth;
  recommendedAgents: string[];
  reasons: string[];
  estimatedMinutes: number;
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
  const asksForChange = /implementa|implementar|crea|crear|agrega|anade|modifica|modificar|corrige|corregir|refactor|migra|migrar|actualiza|actualizar|desarrolla|desarrollar/.test(text);
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
    agents = broadScope || explicitDeep ? ["architect", "implementer", "reviewer", "tester", "build"] : ["architect", "implementer", "reviewer", "tester"];
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
    kind = "architecture-review"; agents = ["architect", "reviewer", "tester"];
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
  return { kind, complexity, depth: selectedDepth, recommendedAgents: agents, reasons,
    estimatedMinutes: selectedDepth === "quick" ? 1 : selectedDepth === "focused" ? 5 : 15, changesExpected };
}

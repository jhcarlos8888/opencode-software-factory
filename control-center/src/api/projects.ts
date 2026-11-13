import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, resolve } from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";

const execFileAsync = promisify(execFile);

const manifests = [
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "Cargo.toml",
  "go.mod"
];

export interface ProjectAnalysis {
  name: string;
  path: string;
  stacks: string[];
  manifests: string[];
  instructions: string[];
  git: { isRepository: boolean; status: string[] };
  recommendations: string[];
  mode: "read-only";
  objective: string;
  complexity: { level: "low" | "medium" | "high" | "very-high"; score: number; reasons: string[]; fileCount: number; };
}

export async function analyzeProject(rawPath: string, objective = ""): Promise<ProjectAnalysis> {
  if (!rawPath || !resolve(rawPath)) {
    throw new Error("Indica una ruta de proyecto válida.");
  }

  const projectPath = resolve(rawPath);
  if (!projectPath.startsWith("/") || rawPath.trim() !== rawPath) {
    throw new Error("La ruta del proyecto debe ser absoluta y no contener espacios al inicio o final.");
  }

  const info = await stat(projectPath);
  if (!info.isDirectory()) {
    throw new Error("La ruta indicada no es un directorio.");
  }

  const entries = new Set(await readdir(projectPath));
  const ignored = new Set([".git", "node_modules", "build", "dist", ".gradle", ".idea", "target", ".next", "vendor", ".venv"]);
  let fileCount = 0;
  const countFiles = async (dir: string, depth: number): Promise<void> => {
    if (depth > 5 || fileCount >= 5000) return;
    let children;
    try { children = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const child of children) {
      if (fileCount >= 5000) break;
      if (child.isDirectory()) {
        if (!ignored.has(child.name)) await countFiles(resolve(dir, child.name), depth + 1);
      } else if (child.isFile()) fileCount++;
    }
  };
  await countFiles(projectPath, 0);
  const presentManifests = manifests.filter((name) => entries.has(name));
  const instructions = ["AGENTS.md", "CLAUDE.md", "README.md"]
    .filter((name) => entries.has(name));

  const stacks: string[] = [];
  if (entries.has("pom.xml")) stacks.push("Java / Maven");
  if (entries.has("build.gradle") || entries.has("build.gradle.kts")) stacks.push("Java / Gradle");
  if (entries.has("package.json")) stacks.push("Node.js / JavaScript / TypeScript");
  let pythonSources = [...entries].some((name) => name.endsWith(".py"));
  for (const directory of ["scripts", "src"]) {
    if (!pythonSources && entries.has(directory)) {
      try {
        pythonSources = (await readdir(resolve(projectPath, directory))).some((name) => name.endsWith(".py"));
      } catch {
        // La detección continúa con los manifiestos que sí pudieron consultarse.
      }
    }
  }
  if (entries.has("pyproject.toml") || entries.has("requirements.txt") || entries.has("Pipfile") || entries.has("setup.py") || pythonSources) {
    stacks.push("Python");
  }
  if (entries.has("Cargo.toml")) stacks.push("Rust");
  if (entries.has("go.mod")) stacks.push("Go");
  if ([...entries].some((name) => name.endsWith(".sln") || name.endsWith(".csproj"))) stacks.push(".NET");
  if (stacks.length === 0 && entries.has("src")) stacks.push("Proyecto con directorio src (stack por confirmar)");
  if (stacks.length === 0) stacks.push("Stack no identificado");

  let gitStatus: string[] = [];
  let isRepository = false;
  try {
    const { stdout } = await execFileAsync("git", ["-C", projectPath, "status", "--short", "--branch"], {
      timeout: 5000,
      maxBuffer: 1024 * 1024
    });
    isRepository = true;
    gitStatus = stdout.trim().split(/\r?\n/).filter(Boolean);
  } catch {
    gitStatus = ["No se pudo obtener estado Git (no es repositorio o Git no está disponible)."];
  }

  const recommendations = [
    "Arquitecto: descubrir estructura, dependencias e instrucciones antes de proponer cambios.",
    "Implementador: trabajar en una rama o Git Worktree separado.",
    "Revisor: recibir el diff y criterios de aceptación en modo de solo lectura.",
    "QA: ejecutar los comandos reales del proyecto y adjuntar código de salida y evidencia."
  ];

  // Se lee únicamente documentación no sensible y limitada; nunca .env ni credenciales.
  const readmePath = instructions.includes("README.md")
    ? resolve(projectPath, "README.md")
    : null;
  let readmePreview = "";
  if (readmePath) {
    const text = await readFile(readmePath, "utf8");
    readmePreview = text.split(/\r?\n/).slice(0, 80).join("\n").slice(0, 12000);
  }

  const complexityReasons: string[] = [];
  let complexityScore = 0;
  if (fileCount > 1000) { complexityScore += 3; complexityReasons.push("Más de 1.000 archivos fuente/documentación detectados (conteo limitado a 5.000)."); }
  else if (fileCount > 250) { complexityScore += 2; complexityReasons.push("Repositorio de tamaño medio/alto por cantidad de archivos."); }
  else if (fileCount > 80) { complexityScore += 1; complexityReasons.push("Más de 80 archivos detectados."); }
  if (presentManifests.length > 2) { complexityScore += 2; complexityReasons.push("Varios manifiestos o módulos tecnológicos."); }
  else if (presentManifests.length > 1) { complexityScore += 1; complexityReasons.push("Más de un manifiesto tecnológico."); }
  if (stacks.length > 2) { complexityScore += 2; complexityReasons.push("Arquitectura con múltiples stacks."); }
  else if (stacks.length > 1) { complexityScore += 1; complexityReasons.push("Más de un stack detectado."); }
  if (instructions.length > 1) { complexityScore += 1; complexityReasons.push("Múltiples documentos de instrucciones/contexto."); }
  if (gitStatus.length > 15) { complexityScore += 1; complexityReasons.push("Numerosos cambios Git pendientes."); }
  if (complexityReasons.length === 0) complexityReasons.push("Estructura pequeña y pocos indicadores de complejidad detectados.");
  const complexityLevel = complexityScore >= 7 ? "very-high" : complexityScore >= 5 ? "high" : complexityScore >= 3 ? "medium" : "low";

  return {
    name: basename(projectPath),
    path: projectPath,
    stacks,
    manifests: presentManifests,
    instructions,
    git: { isRepository, status: gitStatus },
    recommendations: readmePreview
      ? [...recommendations, "README.md leído parcialmente (primeras 80 líneas) para contexto."]
      : recommendations,
    mode: "read-only",
    objective: objective.trim(),
    complexity: { level: complexityLevel, score: complexityScore, reasons: complexityReasons, fileCount }
  };
}

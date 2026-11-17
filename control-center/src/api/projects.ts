import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { readdir, realpath, stat } from "node:fs/promises";
import { planTask, type TaskPlan } from "./task-planner.js";

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
  /** Canonical real path; symlink aliases are never used as the execution root. */
  path: string;
  stacks: string[];
  manifests: string[];
  instructions: string[];
  git: { isRepository: boolean; status: string[] };
  recommendations: string[];
  mode: "read-only";
  objective: string;
  complexity: { level: "low" | "medium" | "high" | "very-high"; score: number; reasons: string[]; fileCount: number; };
  taskPlan: TaskPlan;
}

function isWithinDirectory(directory: string, candidate: string): boolean {
  const rel = relative(directory, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}

async function safeDirectoryEntries(projectRoot: string, name: string): Promise<string[]> {
  const candidate = resolve(projectRoot, name);
  const canonical = await realpath(candidate).catch(() => null);
  if (!canonical || !isWithinDirectory(projectRoot, canonical)) return [];
  const info = await stat(canonical).catch(() => null);
  if (!info?.isDirectory()) return [];
  const entries = await readdir(canonical, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
}

export async function analyzeProject(rawPath: string, objective = ""): Promise<ProjectAnalysis> {
  if (
    typeof rawPath !== "string" ||
    !rawPath ||
    rawPath.length > 4096 ||
    rawPath.trim() !== rawPath ||
    !isAbsolute(rawPath)
  ) {
    throw new Error("La ruta del proyecto debe ser absoluta, válida y no contener espacios al inicio o final.");
  }

  // Canonicalize once before inspecting anything. A symlink may be selected as
  // the project root, but subsequent execution and permission checks use its
  // real target, never the alias.
  const projectPath = await realpath(rawPath).catch(() => null);
  if (!projectPath) throw new Error("La ruta del proyecto no existe o no es accesible.");
  const info = await stat(projectPath).catch(() => null);
  if (!info?.isDirectory()) throw new Error("La ruta indicada no es un directorio.");

  const rootEntries = await readdir(projectPath, { withFileTypes: true });
  const regularFiles = new Set(rootEntries.filter((entry) => entry.isFile()).map((entry) => entry.name));
  const directories = new Set(rootEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));

  const ignored = new Set([".git", "node_modules", "build", "dist", ".gradle", ".idea", "target", ".next", "vendor", ".venv"]);
  let fileCount = 0;
  const countFiles = async (dir: string, depth: number): Promise<void> => {
    if (depth > 5 || fileCount >= 5000) return;
    let children;
    try { children = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const child of children) {
      if (fileCount >= 5000) break;
      // Dirent.isDirectory/isFile are false for symlinks: never follow project
      // links while counting the tree.
      if (child.isDirectory()) {
        if (!ignored.has(child.name)) await countFiles(resolve(dir, child.name), depth + 1);
      } else if (child.isFile()) {
        fileCount++;
      }
    }
  };
  await countFiles(projectPath, 0);

  // Only regular files directly inside the canonical project root are treated
  // as manifests or agent instruction documents. Symlinks are ignored.
  const presentManifests = manifests.filter((name) => regularFiles.has(name));
  const instructions = ["AGENTS.md", "CLAUDE.md", "README.md"]
    .filter((name) => regularFiles.has(name));

  const stacks: string[] = [];
  if (presentManifests.includes("pom.xml")) stacks.push("Java / Maven");
  if (presentManifests.includes("build.gradle") || presentManifests.includes("build.gradle.kts")) stacks.push("Java / Gradle");
  if (presentManifests.includes("package.json")) stacks.push("Node.js / JavaScript / TypeScript");

  let pythonSources = [...regularFiles].some((name) => name.endsWith(".py"));
  for (const directory of ["scripts", "src"]) {
    if (!pythonSources && directories.has(directory)) {
      const childFiles = await safeDirectoryEntries(projectPath, directory);
      pythonSources = childFiles.some((name) => name.endsWith(".py"));
    }
  }
  if (presentManifests.includes("pyproject.toml") || presentManifests.includes("requirements.txt") ||
      regularFiles.has("Pipfile") || regularFiles.has("setup.py") || pythonSources) {
    stacks.push("Python");
  }
  if (presentManifests.includes("Cargo.toml")) stacks.push("Rust");
  if (presentManifests.includes("go.mod")) stacks.push("Go");
  if ([...regularFiles].some((name) => name.endsWith(".sln") || name.endsWith(".csproj"))) stacks.push(".NET");
  if (stacks.length === 0 && directories.has("src")) stacks.push("Proyecto con directorio src (stack por confirmar)");
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
  if (instructions.includes("README.md")) {
    recommendations.push("README.md disponible como documentación dentro del proyecto para la fase de descubrimiento.");
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
    recommendations,
    mode: "read-only",
    objective: objective.trim(),
    complexity: { level: complexityLevel, score: complexityScore, reasons: complexityReasons, fileCount },
    taskPlan: planTask(objective)
  };
}

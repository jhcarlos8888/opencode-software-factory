import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { readdir, realpath, stat } from "node:fs/promises";
import { recommendProjectTeam, type ProjectTeamRecommendation, type ResearchDepth } from "./task-planner.js";

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
  projectStructure: {
    topLevelDirectories: string[];
    modules: string[];
    nestedManifests: string[];
    depthLimit: number;
    fileLimit: number;
    fileCountLimited: boolean;
  };
  complexity: { level: "low" | "medium" | "high" | "very-high"; score: number; reasons: string[]; fileCount: number; };
  projectPlan: ProjectTeamRecommendation;
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

export async function analyzeProject(rawPath: string, depth: ResearchDepth = "focused"): Promise<ProjectAnalysis> {
  if (!["quick", "focused", "deep"].includes(depth)) {
    throw new Error("La profundidad de preconsulta debe ser quick, focused o deep.");
  }
  const scanLimits = depth === "quick"
    ? { depth: 2, files: 1000 }
    : depth === "deep"
      ? { depth: 8, files: 12000 }
      : { depth: 5, files: 5000 };
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
  const nestedManifests: string[] = [];
  const manifestNames = new Set(manifests);
  const countFiles = async (dir: string, currentDepth: number): Promise<void> => {
    if (currentDepth > scanLimits.depth || fileCount >= scanLimits.files) return;
    let children;
    try { children = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const child of children) {
      if (fileCount >= scanLimits.files) break;
      // Dirent.isDirectory/isFile are false for symlinks: never follow project
      // links while counting or discovering nested manifests.
      if (child.isDirectory()) {
        if (!ignored.has(child.name)) await countFiles(resolve(dir, child.name), currentDepth + 1);
      } else if (child.isFile()) {
        fileCount++;
        if (currentDepth > 0 && manifestNames.has(child.name) && nestedManifests.length < 80) {
          nestedManifests.push(resolve(dir, child.name).slice(projectPath.length + 1));
        }
      }
    }
  };
  await countFiles(projectPath, 0);
  const topLevelDirectories = [...directories].sort().slice(0, 40);
  const modules = [...new Set(nestedManifests.map((item) => item.split(sep).slice(0, -1).join(sep)))]
    .filter(Boolean)
    .sort()
    .slice(0, 40);
  const fileCountLimited = fileCount >= scanLimits.files;

  // Only regular files directly inside the canonical project root are treated
  // as manifests or agent instruction documents. Symlinks are ignored.
  const presentManifests = manifests.filter((name) => regularFiles.has(name));
  const instructions = ["AGENTS.md", "CLAUDE.md", "README.md"]
    .filter((name) => regularFiles.has(name));

  const detectedManifestNames = new Set([
    ...presentManifests,
    ...nestedManifests.map((item) => basename(item))
  ]);
  const stacks: string[] = [];
  if (detectedManifestNames.has("pom.xml")) stacks.push("Java / Maven");
  if (detectedManifestNames.has("build.gradle") || detectedManifestNames.has("build.gradle.kts")) stacks.push("Java / Gradle");
  if (detectedManifestNames.has("package.json")) stacks.push("Node.js / JavaScript / TypeScript");

  let pythonSources = [...regularFiles].some((name) => name.endsWith(".py"));
  for (const directory of ["scripts", "src"]) {
    if (!pythonSources && directories.has(directory)) {
      const childFiles = await safeDirectoryEntries(projectPath, directory);
      pythonSources = childFiles.some((name) => name.endsWith(".py"));
    }
  }
  if (detectedManifestNames.has("pyproject.toml") || detectedManifestNames.has("requirements.txt") ||
      regularFiles.has("Pipfile") || regularFiles.has("setup.py") || pythonSources) {
    stacks.push("Python");
  }
  if (detectedManifestNames.has("Cargo.toml")) stacks.push("Rust");
  if (detectedManifestNames.has("go.mod")) stacks.push("Go");
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
  if (fileCount > 1000) { complexityScore += 3; complexityReasons.push("Más de 1.000 archivos fuente/documentación detectados (el recorrido está limitado según la profundidad elegida)."); }
  else if (fileCount > 250) { complexityScore += 2; complexityReasons.push("Repositorio de tamaño medio/alto por cantidad de archivos."); }
  else if (fileCount > 80) { complexityScore += 1; complexityReasons.push("Más de 80 archivos detectados."); }
  const allManifestCount = presentManifests.length + nestedManifests.length;
  if (modules.length >= 8) { complexityScore += 3; complexityReasons.push("Arquitectura modular extensa: se detectaron múltiples módulos con manifiestos propios."); }
  else if (modules.length >= 3) { complexityScore += 2; complexityReasons.push("Se detectaron varios módulos con manifiestos propios."); }
  else if (modules.length > 0) { complexityScore += 1; complexityReasons.push("Se detectaron manifiestos dentro de submódulos."); }
  if (allManifestCount > 5) { complexityScore += 2; complexityReasons.push("Varios manifiestos tecnológicos distribuidos en el repositorio."); }
  else if (allManifestCount > 2) { complexityScore += 1; complexityReasons.push("Más de dos manifiestos tecnológicos detectados."); }
  if (stacks.length > 2) { complexityScore += 2; complexityReasons.push("Arquitectura con múltiples stacks."); }
  else if (stacks.length > 1) { complexityScore += 1; complexityReasons.push("Más de un stack detectado."); }
  if (instructions.length > 1) { complexityScore += 1; complexityReasons.push("Múltiples documentos de instrucciones/contexto."); }
  if (gitStatus.length > 15) { complexityScore += 1; complexityReasons.push("Numerosos cambios Git pendientes."); }
  if (fileCountLimited) complexityReasons.push("El conteo alcanzó el límite de la profundidad elegida; el total real puede ser mayor.");
  if (complexityReasons.length === 0) complexityReasons.push("Estructura pequeña y pocos indicadores de complejidad detectados.");
  const complexityLevel = complexityScore >= 8 ? "very-high" : complexityScore >= 5 ? "high" : complexityScore >= 3 ? "medium" : "low";
  if (modules.length > 0) recommendations.push(modules.length + " módulo(s) con manifiestos propios detectados durante el recorrido estructural.");

  const projectPlan = recommendProjectTeam({
    complexity: complexityLevel,
    stackCount: stacks.length,
    moduleCount: modules.length,
    manifestCount: allManifestCount
  }, depth);

  return {
    name: basename(projectPath),
    path: projectPath,
    stacks,
    manifests: presentManifests,
    instructions,
    git: { isRepository, status: gitStatus },
    recommendations,
    mode: "read-only",
    projectStructure: {
      topLevelDirectories,
      modules,
      nestedManifests,
      depthLimit: scanLimits.depth,
      fileLimit: scanLimits.files,
      fileCountLimited
    },
    complexity: { level: complexityLevel, score: complexityScore, reasons: complexityReasons, fileCount },
    projectPlan
  };
}

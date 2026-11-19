import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface ClaudeFactorySkillsPlugin {
  path: string;
  skillIds: string[];
  digest: string;
  skillDigests: Record<string, string>;
  fileCount: number;
  totalBytes: number;
}

interface CopyStats {
  files: number;
  bytes: number;
  hash: ReturnType<typeof createHash>;
}

const PLUGIN_NAME = "factory-skills";
const PLUGIN_MARKER = "OpenCode Software Factory · factory-skills";
const MAX_FILES = 1200;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_DEPTH = 12;

function ensureInside(root: string, path: string): void {
  const rel = relative(root, path);
  if (rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep))) return;
  throw new Error("La ruta de una Skill intenta salir de su directorio de origen.");
}

function parseSkillName(markdown: string, directoryName: string): string {
  const match = markdown.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  const frontmatter = match?.[1] ?? "";
  const name = frontmatter.match(/^name:\s*["']?([^"'#\r\n]+)["']?\s*$/m)?.[1]?.trim() ?? directoryName;
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
    throw new Error("La Skill " + directoryName + " tiene un nombre no válido para Claude Code.");
  }
  return name;
}

async function copyDirectorySafely(
  sourceRoot: string,
  sourceDirectory: string,
  destinationDirectory: string,
  depth: number,
  stats: CopyStats
): Promise<void> {
  if (depth > MAX_DEPTH) throw new Error("Una Skill supera la profundidad máxima de copia permitida.");
  const source = await realpath(sourceDirectory);
  ensureInside(sourceRoot, source);
  const sourceInfo = await lstat(sourceDirectory);
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isDirectory()) {
    throw new Error("La fábrica no copia enlaces simbólicos ni rutas que no sean directorios de Skill.");
  }
  await mkdir(destinationDirectory, { recursive: true, mode: 0o700 });

  const entries = await readdir(sourceDirectory, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".DS_Store") continue;
    const sourcePath = join(sourceDirectory, entry.name);
    const destinationPath = join(destinationDirectory, entry.name);
    const info = await lstat(sourcePath);
    if (info.isSymbolicLink()) {
      throw new Error("Se encontró un enlace simbólico dentro de la Skill " + basename(sourceDirectory) + ": " + entry.name);
    }
    if (info.isDirectory()) {
      await copyDirectorySafely(sourceRoot, sourcePath, destinationPath, depth + 1, stats);
      continue;
    }
    if (!info.isFile()) continue;
    if (entry.name.endsWith(".env") || entry.name.startsWith(".env.") ||
        /\.(pem|key|p12|pfx|keystore)$/i.test(entry.name)) {
      throw new Error("Una Skill contiene un archivo de credenciales o clave que no se copiará: " + entry.name);
    }
    const bytes = await readFile(sourcePath);
    stats.files += 1;
    stats.bytes += bytes.byteLength;
    if (stats.files > MAX_FILES || stats.bytes > MAX_TOTAL_BYTES) {
      throw new Error("El conjunto de Skills supera el límite de tamaño permitido.");
    }
    const relativePath = relative(sourceRoot, sourcePath).split(sep).join("/");
    stats.hash.update(relativePath).update("\0").update(bytes).update("\0");
    await writeFile(destinationPath, bytes, { mode: 0o600 });
  }
}

/**
 * Materialize the factory-owned .opencode/skills catalog as a Claude Code
 * local plugin in private application state. Project/user Claude settings are
 * never loaded, source symlinks are rejected, and updates use a recoverable
 * directory swap so a failed refresh cannot destroy the last good plugin.
 */
export async function ensureClaudeFactorySkillsPlugin(
  factoryRoot: string,
  stateDirectory = join(homedir(), ".local", "state", "opencode-software-factory", "claude-plugins")
): Promise<ClaudeFactorySkillsPlugin> {
  const canonicalFactoryRoot = await realpath(factoryRoot);
  const sourceRootPath = join(canonicalFactoryRoot, ".opencode", "skills");
  const sourceRoot = await realpath(sourceRootPath).catch(() => {
    throw new Error("No se encontró el catálogo de Skills de la fábrica en .opencode/skills.");
  });
  ensureInside(canonicalFactoryRoot, sourceRoot);
  const sourceInfo = await lstat(sourceRootPath);
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isDirectory()) {
    throw new Error("El catálogo de Skills debe ser un directorio físico administrado por la fábrica.");
  }

  const requestedStateRoot = resolve(stateDirectory);
  await mkdir(requestedStateRoot, { recursive: true, mode: 0o700 });
  const stateInfo = await lstat(requestedStateRoot);
  if (stateInfo.isSymbolicLink() || !stateInfo.isDirectory()) {
    throw new Error("El directorio privado de Skills de Claude no puede ser un enlace simbólico.");
  }
  const stateRoot = await realpath(requestedStateRoot);
  if (stateRoot === canonicalFactoryRoot || stateRoot.startsWith(canonicalFactoryRoot + sep)) {
    throw new Error("El plugin de Claude debe mantenerse fuera del repositorio y de los proyectos de trabajo.");
  }

  const pluginRoot = join(stateRoot, PLUGIN_NAME);
  const markerPath = join(pluginRoot, ".factory-managed-plugin");
  const existingPluginInfo = await lstat(pluginRoot).catch(() => null);
  if (existingPluginInfo && (existingPluginInfo.isSymbolicLink() || !existingPluginInfo.isDirectory())) {
    throw new Error("La ruta de plugin existente no es un directorio administrado seguro; no se sobrescribirá.");
  }
  const markerInfo = existingPluginInfo ? await lstat(markerPath).catch(() => null) : null;
  if (markerInfo && (markerInfo.isSymbolicLink() || !markerInfo.isFile())) {
    throw new Error("El marcador del plugin existente no es un archivo normal; no se sobrescribirá.");
  }
  const marker = markerInfo ? await readFile(markerPath, "utf8") : "";
  if (marker && marker !== PLUGIN_MARKER) {
    throw new Error("El directorio de plugin existente no pertenece a la fábrica; no se sobrescribirá.");
  }
  if (existingPluginInfo && !marker) {
    const existing = await readdir(pluginRoot);
    if (existing.length) {
      throw new Error("El directorio de plugin ya contiene archivos que la fábrica no reconoce; no se sobrescribirá.");
    }
  }

  const sourceEntries = await readdir(sourceRootPath, { withFileTypes: true });
  if (sourceEntries.some((entry) => entry.isSymbolicLink())) {
    throw new Error("El catálogo de Skills contiene enlaces simbólicos en su raíz; no se copiará parcialmente.");
  }
  const skillDirectories = sourceEntries
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));
  if (skillDirectories.length === 0) throw new Error("No hay Skills propias para habilitar en Claude Code.");

  const stagedRoot = join(stateRoot, PLUGIN_NAME + ".staging-" + randomUUID());
  const backupRoot = join(stateRoot, PLUGIN_NAME + ".backup-" + randomUUID());
  await mkdir(join(stagedRoot, "skills"), { recursive: true, mode: 0o700 });

  const skillIds: string[] = [];
  const skillDigests: Record<string, string> = {};
  const totalStats: CopyStats = { files: 0, bytes: 0, hash: createHash("sha256") };
  let previousPluginMoved = false;
  try {
    for (const entry of skillDirectories) {
      const sourceSkill = join(sourceRootPath, entry.name);
      const skillManifest = join(sourceSkill, "SKILL.md");
      const manifestInfo = await lstat(skillManifest).catch(() => null);
      if (!manifestInfo || !manifestInfo.isFile() || manifestInfo.isSymbolicLink()) {
        throw new Error("La carpeta " + entry.name + " no contiene un SKILL.md válido; no se omitirá silenciosamente.");
      }
      const manifestText = await readFile(skillManifest, "utf8");
      const skillId = parseSkillName(manifestText, entry.name);
      if (skillIds.includes(skillId)) throw new Error("Hay nombres de Skill duplicados: " + skillId + ".");
      const perSkillStats: CopyStats = { files: 0, bytes: 0, hash: createHash("sha256") };
      const destinationSkill = join(stagedRoot, "skills", entry.name);
      await copyDirectorySafely(sourceRoot, sourceSkill, destinationSkill, 0, perSkillStats);
      const skillDigest = perSkillStats.hash.digest("hex");
      skillIds.push(skillId);
      skillDigests[skillId] = skillDigest;
      totalStats.files += perSkillStats.files;
      totalStats.bytes += perSkillStats.bytes;
      totalStats.hash.update(entry.name).update("\0").update(skillDigest).update("\0");
    }

    if (!skillIds.length) throw new Error("Ninguna Skill contiene un SKILL.md válido.");
    if (totalStats.files > MAX_FILES || totalStats.bytes > MAX_TOTAL_BYTES) {
      throw new Error("El catálogo de Skills supera el límite de tamaño permitido.");
    }

    const pluginManifest = {
      name: PLUGIN_NAME,
      version: "1.0.0",
      description: "Skills internas y verificadas de OpenCode Software Factory."
    };
    await mkdir(join(stagedRoot, ".claude-plugin"), { recursive: true, mode: 0o700 });
    await writeFile(join(stagedRoot, ".claude-plugin", "plugin.json"), JSON.stringify(pluginManifest, null, 2) + "\n", { mode: 0o600 });
    await writeFile(join(stagedRoot, ".factory-managed-plugin"), PLUGIN_MARKER, { mode: 0o600 });
    const digest = totalStats.hash.digest("hex");
    await writeFile(join(stagedRoot, ".factory-skills-manifest.json"), JSON.stringify({
      source: canonicalFactoryRoot,
      skillIds,
      skillDigests,
      fileCount: totalStats.files,
      totalBytes: totalStats.bytes,
      digest
    }, null, 2) + "\n", { mode: 0o600 });

    if (existingPluginInfo) {
      await rename(pluginRoot, backupRoot);
      previousPluginMoved = true;
    }
    try {
      await rename(stagedRoot, pluginRoot);
    } catch (error) {
      if (previousPluginMoved) {
        await rename(backupRoot, pluginRoot).catch(() => undefined);
        previousPluginMoved = false;
      }
      throw error;
    }
    if (previousPluginMoved) {
      await rm(backupRoot, { recursive: true, force: true }).catch(() => undefined);
      previousPluginMoved = false;
    }

    return {
      path: pluginRoot,
      skillIds,
      digest,
      skillDigests,
      fileCount: totalStats.files,
      totalBytes: totalStats.bytes
    };
  } catch (error) {
    await rm(stagedRoot, { recursive: true, force: true });
    if (previousPluginMoved) {
      const installed = await lstat(pluginRoot).catch(() => null);
      if (!installed) await rename(backupRoot, pluginRoot).catch(() => undefined);
    }
    throw error;
  }
}
/** Build the explicit SDK plugin contract; never enable Claude's global settings. */
export function buildClaudeFactorySkillsSdkOptions(plugin: ClaudeFactorySkillsPlugin): {
  plugins: Array<{ type: "local"; path: string; skipMcpDiscovery: true }>;
  pluginDelivery: "initialize";
  skills: string[];
} {
  return {
    plugins: [{ type: "local", path: plugin.path, skipMcpDiscovery: true }],
    pluginDelivery: "initialize",
    skills: plugin.skillIds.map((skillId) => PLUGIN_NAME + ":" + skillId)
  };
}

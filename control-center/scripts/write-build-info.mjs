import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CONTROL_CENTER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FACTORY_ROOT = resolve(CONTROL_CENTER_ROOT, "..");

const DEFAULT_INPUTS = [
  "README.md",
  "AGENTS.md",
  "control-center/README.md",
  "control-center/src/api",
  "control-center/src/web",
  "control-center/package.json",
  "control-center/package-lock.json",
  "control-center/tsconfig.api.json",
  "control-center/tsconfig.web.json",
  "control-center/vite.config.ts",
  "control-center/scripts/write-build-info.mjs",
  "control-center/scripts/deploy.sh",
  "control-center/scripts/security-audit.mjs",
  "control-center/scripts/security-audit.test.mjs",
  "opencode.json",
  ".opencode/agents",
  ".opencode/mcp",
  ".opencode/skills",
  ".opencode/commands",
  ".agents/skills",
  "templates/AGENTS.md",
  "templates/quality",
  "scripts/factory.py",
  "scripts/factory-filesystem.test.mjs",
  "scripts/verify-opencode-agents.py",
  "scripts/verify-opencode-agents.test.py",
  "scripts/verify-factory.sh",
  "docs"
];

const IGNORED_DIRECTORIES = new Set(["node_modules", ".git", "dist", "dist-api"]);

async function collectFiles(factoryRoot, inputs) {
  const root = resolve(factoryRoot);
  const files = [];

  async function visit(absolute, relativePath) {
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      throw new Error(`El fingerprint de build no admite symlinks: ${relativePath}`);
    }
    if (info.isFile()) {
      files.push({ absolute, relativePath });
      return;
    }
    if (!info.isDirectory()) {
      throw new Error(`Entrada de build no regular: ${relativePath}`);
    }
    const entries = await readdir(absolute, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        throw new Error(`El fingerprint de build no admite symlinks: ${relativePath}/${entry.name}`);
      }
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      const child = join(absolute, entry.name);
      const childRelative = `${relativePath}/${entry.name}`;
      if (entry.isDirectory() || entry.isFile()) await visit(child, childRelative);
    }
  }

  for (const input of inputs) {
    const absolute = resolve(root, input);
    const relativePath = relative(root, absolute).split(sep).join("/");
    if (!relativePath || relativePath === ".." || relativePath.startsWith("../")) {
      throw new Error(`Entrada de build fuera de la fábrica: ${input}`);
    }
    try {
      const parts = relativePath.split("/");
      let cursor = root;
      for (const part of parts) {
        cursor = join(cursor, part);
        const ancestorInfo = await lstat(cursor);
        if (ancestorInfo.isSymbolicLink()) {
          throw new Error(`El fingerprint de build no admite symlinks: ${relative(root, cursor).split(sep).join("/")}`);
        }
      }
      await visit(absolute, relativePath);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        throw new Error(`Falta una entrada necesaria para identificar el build: ${relativePath}`);
      }
      throw error;
    }
  }

  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return files;
}

export async function createBuildInfo(factoryRoot = FACTORY_ROOT, options = {}) {
  const inputs = options.inputs ?? DEFAULT_INPUTS;
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const files = await collectFiles(factoryRoot, inputs);
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.relativePath, "utf8");
    hash.update(Buffer.from([0]));
    hash.update(await readFile(file.absolute));
    hash.update(Buffer.from([0]));
  }
  return {
    schemaVersion: 1,
    buildId: `sha256:${hash.digest("hex")}`,
    generatedAt,
    sourceFileCount: files.length,
    sourceFiles: files.map((file) => file.relativePath)
  };
}

export async function writeBuildInfo(
  factoryRoot = FACTORY_ROOT,
  outputPath = join(CONTROL_CENTER_ROOT, "dist-api", "api", "build-info.json"),
  options = {}
) {
  const info = await createBuildInfo(factoryRoot, options);
  const directory = dirname(outputPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new Error("El directorio del fingerprint no puede ser un enlace simbólico.");
  }
  try {
    const existing = await lstat(outputPath);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new Error("El artefacto del fingerprint existente no es un archivo regular.");
    }
  } catch (error) {
    const missing = error && typeof error === "object" && "code" in error && error.code === "ENOENT";
    if (!missing) throw error;
  }

  const temporaryPath = join(directory, `.build-info.${process.pid}.${randomUUID()}.tmp`);
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(temporaryPath, flags, 0o600);
  try {
    await handle.writeFile(JSON.stringify(info, null, 2) + "\n", "utf8");
    await handle.sync();
    await handle.close();
    await rename(temporaryPath, outputPath);
    const directoryHandle = await open(directory, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0));
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  } catch (error) {
    try { await handle.close(); } catch { /* already closed */ }
    try { await unlink(temporaryPath); } catch { /* no temporary file remains */ }
    throw error;
  }
  return info;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) {
  try {
    const info = await writeBuildInfo();
    process.stdout.write(`Build fingerprint generado: ${info.buildId} (${info.sourceFileCount} archivos)\n`);
  } catch (error) {
    process.stderr.write(`ERROR: no se pudo generar el fingerprint del build: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

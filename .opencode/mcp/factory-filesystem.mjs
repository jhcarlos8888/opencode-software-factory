#!/usr/bin/env node
/**
 * Read-only, project-rooted filesystem MCP for OpenCode.
 *
 * OpenCode V2 authorizes native Glob by pattern and Grep by regex, not by
 * their search path. This server replaces those native tools with operations
 * that canonicalize every requested path, never follow symlinks and skip
 * sensitive paths before reading or enumerating files.
 *
 * No external dependencies, network access, shell execution or write tools.
 */

import { createInterface } from "node:readline";
import { open, realpath, readdir, stat, lstat } from "node:fs/promises";
import { constants as fsConstants, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_INPUT_LINE = 1024 * 1024;
const MAX_PATH_LENGTH = 4096;
const MAX_READ_BYTES = 128 * 1024;
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
const MAX_SEARCH_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_SEARCH_FILES = 1500;
const MAX_LIST_ENTRIES = 500;
const MAX_SEARCH_RESULTS = 100;
const MAX_DEPTH = 8;

const IGNORED_DIRECTORIES = new Set([
  ".git", ".hg", ".svn", ".bzr", "node_modules", "vendor",
  "build", "dist", "target", ".gradle", ".next", ".nuxt",
  ".venv", "venv", "__pycache__", "coverage", ".turbo"
]);

const SENSITIVE_DIRECTORIES = new Set([
  ".git", ".hg", ".svn", ".bzr", ".ssh", ".aws", ".azure",
  ".config", ".local", ".gnupg", ".kube", ".docker", ".npm",
  ".pki", ".claude"
]);

const SENSITIVE_FILES = new Set([
  ".env", ".netrc", ".npmrc", ".pypirc", ".pgpass",
  ".my.cnf", ".htpasswd", ".envrc"
]);

const SENSITIVE_EXTENSIONS = new Set([
  ".pem", ".key", ".p12", ".pfx", ".p7b", ".p7c",
  ".der", ".jks", ".keystore", ".kdbx", ".ppk", ".crt"
]);

const SENSITIVE_NAME =
  /(?:^|[._-])(?:credentials?|secrets?|token|api[_-]?key|private[_-]?key|id_rsa|id_ed25519)(?:$|[._-])/i;

function pathSegments(value) {
  return value.replace(/\\/g, "/").split("/").filter(Boolean);
}

function isSensitiveSegment(segment) {
  const lower = segment.toLowerCase();
  if (SENSITIVE_DIRECTORIES.has(lower) || SENSITIVE_FILES.has(lower)) return true;
  if (/^\.env(?:$|[.*?])/i.test(segment)) return true;
  const dot = lower.lastIndexOf(".");
  if (dot >= 0 && SENSITIVE_EXTENSIONS.has(lower.slice(dot))) return true;
  return SENSITIVE_NAME.test(segment);
}

function isSensitiveRelativePath(value) {
  return pathSegments(value).some(isSensitiveSegment);
}

function containsPath(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}

function isValidRelativePath(value) {
  if (
    typeof value !== "string" ||
    value.length > MAX_PATH_LENGTH ||
    value.includes("\0") ||
    isAbsolute(value) ||
    /^[a-zA-Z]:[\\/]/.test(value) ||
    value.startsWith("~") ||
    value.includes("://")
  ) return false;

  const segments = pathSegments(value);
  return !segments.some((segment) => segment === "..");
}

export async function createProjectFilesystem(rootCandidate = process.cwd()) {
  const root = await realpath(rootCandidate);
  const rootInfo = await stat(root);
  if (!rootInfo.isDirectory()) {
    throw new Error("El directorio de trabajo de OpenCode no es una carpeta.");
  }

  async function readDirectoryNoFollow(absolute, expectedRelative) {
    const flags = fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0);
    const handle = await open(absolute, flags);
    try {
      const info = await handle.stat();
      if (!info.isDirectory()) throw new Error("El directorio cambió durante la enumeración.");
      const descriptorPath = await realpath(`/proc/self/fd/${handle.fd}`);
      const expectedAbsolute = expectedRelative === "." ? root : resolve(root, expectedRelative);
      const currentPath = await realpath(absolute);
      if (descriptorPath !== expectedAbsolute || currentPath !== descriptorPath || !containsPath(root, descriptorPath)) {
        throw new Error("El directorio cambió de identidad o resolvió fuera del proyecto.");
      }
      return await readdir(`/proc/self/fd/${handle.fd}`, { withFileTypes: true });
    } finally {
      await handle.close();
    }
  }

  async function readFileNoFollow(absolute, expectedRelative, maxBytes) {
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
    const handle = await open(absolute, flags);
    try {
      const before = await handle.stat();
      if (!before.isFile()) throw new Error("El archivo dejó de ser regular.");
      if (before.size > maxBytes) throw new Error(`El archivo supera el límite seguro de ${maxBytes} bytes.`);
      const descriptorPath = await realpath(`/proc/self/fd/${handle.fd}`);
      const expectedAbsolute = resolve(root, expectedRelative);
      const currentPath = await realpath(absolute);
      if (descriptorPath !== expectedAbsolute || currentPath !== descriptorPath || !containsPath(root, descriptorPath)) {
        throw new Error("El archivo cambió de identidad o resolvió fuera del proyecto.");
      }
      const buffer = await handle.readFile();
      const after = await handle.stat();
      if (before.dev !== after.dev || before.ino !== after.ino || after.size > maxBytes || buffer.length > maxBytes) {
        throw new Error("El archivo cambió mientras se estaba leyendo.");
      }
      return { buffer, info: after };
    } finally {
      await handle.close();
    }
  }

  async function resolveInside(relativePath = ".") {
    if (!isValidRelativePath(relativePath)) {
      throw new Error("La ruta debe ser relativa al proyecto y no puede contener traversal, URI o rutas absolutas.");
    }
    if (isSensitiveRelativePath(relativePath)) {
      throw new Error("La ruta selecciona metadatos o archivos sensibles y está bloqueada.");
    }

    const lexical = resolve(root, relativePath || ".");
    if (!containsPath(root, lexical)) {
      throw new Error("La ruta solicitada está fuera del proyecto.");
    }

    // Inspect every supplied path component without following links. Even a
    // symlink whose target remains inside the root is refused for predictable
    // file identity and to avoid later retargeting races.
    let current = root;
    for (const segment of pathSegments(relativePath)) {
      if (segment === ".") continue;
      current = resolve(current, segment);
      let componentInfo;
      try { componentInfo = await lstat(current); } catch {
        throw new Error("La ruta no existe o no es accesible dentro del proyecto.");
      }
      if (componentInfo.isSymbolicLink()) {
        throw new Error("Los enlaces simbólicos están bloqueados en herramientas de lectura.");
      }
    }

    let canonical;
    try {
      canonical = await realpath(lexical);
    } catch {
      throw new Error("La ruta no existe o no es accesible dentro del proyecto.");
    }

    if (!containsPath(root, canonical)) {
      throw new Error("La ruta resuelve fuera del proyecto y está bloqueada.");
    }

    const canonicalRelative = relative(root, canonical).split(sep).join("/");
    if (isSensitiveRelativePath(canonicalRelative)) {
      throw new Error("La ruta resuelve a metadatos o archivos sensibles y está bloqueada.");
    }

    // realpath of the full path detects symlink escapes; enumeration below
    // separately refuses every symlink entry to avoid following project links.
    const info = await stat(canonical);
    return { absolute: canonical, relative: canonicalRelative || ".", info };
  }

  async function listFiles({ path = ".", max_depth = 4, max_entries = 250 } = {}) {
    const start = await resolveInside(path);
    if (!start.info.isDirectory()) throw new Error("La ruta solicitada no es un directorio.");

    const depthLimit = Math.max(0, Math.min(Number.isInteger(max_depth) ? max_depth : 4, MAX_DEPTH));
    const entryLimit = Math.max(1, Math.min(Number.isInteger(max_entries) ? max_entries : 250, MAX_LIST_ENTRIES));
    const results = [];
    let truncated = false;

    async function visit(directory, relativeDirectory, depth) {
      if (results.length >= entryLimit) {
        truncated = true;
        return;
      }
      if (depth > depthLimit) return;

      let entries;
      try {
        entries = await readDirectoryNoFollow(directory, relativeDirectory);
      } catch {
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));

      for (const entry of entries) {
        if (results.length >= entryLimit) {
          truncated = true;
          break;
        }
        const rel = relativeDirectory === "." ? entry.name : relativeDirectory + "/" + entry.name;
        if (isSensitiveRelativePath(rel)) continue;
        if (entry.isSymbolicLink()) continue;

        if (entry.isDirectory()) {
          if (IGNORED_DIRECTORIES.has(entry.name)) continue;
          results.push({ path: rel + "/", type: "directory" });
          if (depth < depthLimit) await visit(resolve(directory, entry.name), rel, depth + 1);
        } else if (entry.isFile()) {
          let info;
          try { info = await lstat(resolve(directory, entry.name)); } catch { continue; }
          if (!info.isFile() || info.isSymbolicLink()) continue;
          results.push({ path: rel, type: "file", bytes: info.size });
        }
      }
    }

    await visit(start.absolute, start.relative, 0);
    return {
      root: start.relative,
      entries: results,
      count: results.length,
      truncated,
      note: "Solo rutas relativas del proyecto; los symlinks, directorios de dependencias y rutas sensibles se excluyen."
    };
  }

  async function readProjectFile({ path, start_line = 1, line_count = 160 } = {}) {
    const target = await resolveInside(path);
    if (!target.info.isFile()) throw new Error("La ruta solicitada no es un archivo regular.");
    if (target.info.size > MAX_READ_BYTES) {
      throw new Error("El archivo supera el límite de lectura segura de 128 KiB. Usa búsqueda textual acotada.");
    }

    const { buffer: raw } = await readFileNoFollow(target.absolute, target.relative, MAX_READ_BYTES);
    if (raw.includes(0)) throw new Error("El archivo parece binario y no se mostrará como texto.");
    const text = raw.toString("utf8");
    const lines = text.split(/\r?\n/);
    const from = Math.max(1, Number.isInteger(start_line) ? start_line : 1);
    const count = Math.max(1, Math.min(Number.isInteger(line_count) ? line_count : 160, 400));
    const selected = lines.slice(from - 1, from - 1 + count);
    return {
      path: target.relative,
      start_line: from,
      total_lines: lines.length,
      returned_lines: selected.length,
      truncated: from - 1 + selected.length < lines.length,
      content: selected.map((line, index) => String(from + index).padStart(5, " ") + " | " + line).join("\n")
    };
  }

  async function searchText({
    query,
    path = ".",
    case_sensitive = false,
    max_results = 50
  } = {}) {
    if (typeof query !== "string" || !query.trim() || query.length > 256 || query.includes("\0")) {
      throw new Error("La búsqueda requiere un texto literal de 1 a 256 caracteres.");
    }
    const start = await resolveInside(path);
    if (!start.info.isDirectory()) throw new Error("El ámbito de búsqueda debe ser un directorio del proyecto.");

    const resultLimit = Math.max(1, Math.min(Number.isInteger(max_results) ? max_results : 50, MAX_SEARCH_RESULTS));
    const needle = case_sensitive ? query : query.toLocaleLowerCase();
    const results = [];
    let filesScanned = 0;
    let bytesScanned = 0;
    let truncated = false;

    async function visit(directory, relativeDirectory, depth) {
      if (truncated || depth > MAX_DEPTH) return;
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
      entries.sort((a, b) => a.name.localeCompare(b.name));

      for (const entry of entries) {
        if (truncated) return;
        const rel = relativeDirectory === "." ? entry.name : relativeDirectory + "/" + entry.name;
        if (isSensitiveRelativePath(rel) || entry.isSymbolicLink()) continue;

        if (entry.isDirectory()) {
          if (IGNORED_DIRECTORIES.has(entry.name)) continue;
          await visit(resolve(directory, entry.name), rel, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;

        filesScanned += 1;
        if (filesScanned > MAX_SEARCH_FILES) {
          truncated = true;
          return;
        }

        const absolute = resolve(directory, entry.name);
        let info;
        try { info = await lstat(absolute); } catch { continue; }
        if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SEARCH_FILE_BYTES) continue;
        if (bytesScanned + info.size > MAX_SEARCH_TOTAL_BYTES) {
          truncated = true;
          return;
        }

        let buffer;
        try {
          const opened = await readFileNoFollow(absolute, rel, MAX_SEARCH_FILE_BYTES);
          if (opened.info.dev !== info.dev || opened.info.ino !== info.ino) continue;
          buffer = opened.buffer;
        } catch { continue; }
        if (bytesScanned + buffer.length > MAX_SEARCH_TOTAL_BYTES) {
          truncated = true;
          return;
        }
        bytesScanned += buffer.length;
        if (buffer.includes(0)) continue;

        const content = buffer.toString("utf8");
        const lines = content.split(/\r?\n/);
        for (let index = 0; index < lines.length; index++) {
          const line = lines[index];
          const haystack = case_sensitive ? line : line.toLocaleLowerCase();
          if (!haystack.includes(needle)) continue;
          results.push({
            path: rel,
            line: index + 1,
            excerpt: line.length > 1200 ? line.slice(0, 1200) + "…" : line
          });
          if (results.length >= resultLimit) {
            truncated = true;
            return;
          }
        }
      }
    }

    await visit(start.absolute, start.relative, 0);
    return {
      query,
      root: start.relative,
      matches: results,
      count: results.length,
      files_scanned: Math.min(filesScanned, MAX_SEARCH_FILES),
      bytes_scanned: bytesScanned,
      truncated,
      note: "Búsqueda literal de solo lectura; no sigue symlinks ni incluye rutas sensibles, dependencias o binarios."
    };
  }

  // Read only conventional Gradle/Maven JUnit report directories explicitly
  // selected by the caller. Never return arbitrary XML contents or test logs.
  async function summarizeJUnit({ modules } = {}) {
    if (!Array.isArray(modules) || modules.length < 1 || modules.length > 40 ||
        modules.some((m) => typeof m !== "string" || !/^(?:\.|[\w.-]+(?:\/[\w.-]+)*)$/.test(m) ||
          (m !== "." && m.split("/").some((part) => part === ".." || part === ".")) || isSensitiveRelativePath(m))) {
      throw new Error("Indica entre 1 y 40 rutas relativas de módulos, sin traversal ni patrones.");
    }
    const totals = { tests: 0, failures: 0, errors: 0, skipped: 0 };
    const reports = [];
    const issues = [];
    const seen = new Set();
    let totalBytes = 0;
    let truncated = false;
    for (const module of [...new Set(modules)]) {
      const base = module === "." ? "" : module + "/";
      let found = false;
      const beforeReports = reports.length;
      for (const suffix of ["build/test-results/test", "target/surefire-reports", "target/failsafe-reports"]) {
        const rel = base + suffix;
        let directory;
        try { directory = await resolveInside(rel); } catch { continue; }
        if (!directory.info.isDirectory()) continue;
        found = true;
        let entries;
        try { entries = await readDirectoryNoFollow(directory.absolute, directory.relative); }
        catch { issues.push(rel + ": no se pudo enumerar"); continue; }
        for (const entry of entries.sort((a,b) => a.name.localeCompare(b.name))) {
          if (!/^TEST-[\w.$-]+\.xml$/.test(entry.name)) continue;
          const file = rel + "/" + entry.name;
          if (seen.has(file)) continue;
          seen.add(file);
          if (seen.size > 500 || totalBytes >= 20 * 1024 * 1024) { truncated = true; break; }
          if (!entry.isFile() || entry.isSymbolicLink() || isSensitiveRelativePath(file)) {
            issues.push(file + ": archivo no permitido"); continue;
          }
          try {
            const target = await resolveInside(file);
            const { buffer } = await readFileNoFollow(target.absolute, target.relative,
              Math.min(1024 * 1024, 20 * 1024 * 1024 - totalBytes));
            totalBytes += buffer.length;
            const text = buffer.toString("utf8");
            // Extract only the four numeric attributes of a standard
            // testsuite root. Reject declarations/entities beyond XML header.
            if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error("declaración XML no permitida");
            const head = /^\uFEFF?\s*(?:<\?xml[^?]*\?>\s*)?<testsuite\s+([^<>]{1,8192})>/.exec(text);
            if (!head || !/<\/testsuite>\s*$/.test(text)) throw new Error("formato JUnit no reconocido");
            const attrs = head[1];
            const counts = {};
            for (const key of ["tests","failures","errors","skipped"]) {
              const matches = [...attrs.matchAll(new RegExp("(?:^|\\s)" + key + "\\s*=\\s*([\"'])(\\d{1,8})\\1(?=\\s|$)", "g"))];
              if (matches.length !== 1) throw new Error("contador ausente o ambiguo: " + key);
              counts[key] = Number(matches[0][2]);
            }
            if (counts.failures + counts.errors + counts.skipped > counts.tests) throw new Error("contadores inconsistentes");
            for (const key of Object.keys(totals)) totals[key] += counts[key];
            reports.push({ module, path: file, ...counts });
          } catch { issues.push(file + ": informe no legible o formato no válido"); }
        }
        if (truncated) break;
      }
      if (!found || reports.length === beforeReports) issues.push(module + ": no se encontraron informes JUnit legibles");
      if (truncated) break;
    }
    return { totals, reports, issues, truncated, complete: !truncated && issues.length === 0 && reports.length > 0,
      note: "Contadores declarados en informes existentes; no ejecuta pruebas ni acredita que sean recientes. No suma informes que no pudo leer." };
  }

  return { root, listFiles, readProjectFile, searchText, summarizeJUnit };
}

const TOOL_DEFINITIONS = [
  {
    name: "summarize_junit",
    description: "Resume contadores de informes JUnit Gradle/Maven de módulos explícitos del proyecto, sin ejecutar shell ni mostrar logs. Indica módulos relativos, . para raíz.",
    inputSchema: { type: "object", properties: {
      modules: { type: "array", minItems: 1, maxItems: 40, items: { type: "string" } }
    }, required: ["modules"], additionalProperties: false }
  },
  {
    name: "list_files",
    description: "Lista archivos y directorios dentro del proyecto activo. Nunca sigue enlaces simbólicos ni enumera metadatos o secretos.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Ruta relativa dentro del proyecto; usa . para la raíz." },
        max_depth: { type: "integer", minimum: 0, maximum: MAX_DEPTH, description: "Profundidad máxima (por defecto 4)." },
        max_entries: { type: "integer", minimum: 1, maximum: MAX_LIST_ENTRIES, description: "Máximo de entradas (por defecto 250)." }
      },
      additionalProperties: false
    }
  },
  {
    name: "read_file",
    description: "Lee un archivo de texto pequeño dentro del proyecto, con números de línea. Bloquea secretos, traversal y symlinks.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Ruta relativa del archivo dentro del proyecto." },
        start_line: { type: "integer", minimum: 1, description: "Primera línea (por defecto 1)." },
        line_count: { type: "integer", minimum: 1, maximum: 400, description: "Líneas a devolver (por defecto 160)." }
      },
      required: ["path"],
      additionalProperties: false
    }
  },
  {
    name: "search_text",
    description: "Busca texto literal dentro del proyecto activo. No ejecuta comandos ni acepta expresiones regulares o rutas externas.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 256, description: "Texto literal a buscar." },
        path: { type: "string", description: "Subdirectorio relativo dentro del proyecto; por defecto ." },
        case_sensitive: { type: "boolean", description: "Distinguir mayúsculas y minúsculas." },
        max_results: { type: "integer", minimum: 1, maximum: MAX_SEARCH_RESULTS, description: "Máximo de coincidencias (por defecto 50)." }
      },
      required: ["query"],
      additionalProperties: false
    }
  }
];

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

async function runMcpServer() {
  const filesystem = await createProjectFilesystem(process.cwd());
  const tools = {
    list_files: filesystem.listFiles,
    read_file: filesystem.readProjectFile,
    search_text: filesystem.searchText,
    summarize_junit: filesystem.summarizeJUnit
  };

  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (line.length > MAX_INPUT_LINE) {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "MCP request exceeds 1 MiB." } });
      continue;
    }
    let message;
    try { message = JSON.parse(line); } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON." } });
      continue;
    }
    if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") continue;

    if (message.method === "notifications/initialized" || message.method.startsWith("notifications/")) {
      continue;
    }
    if (message.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? "2024-11-05",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "factory-filesystem", version: "1.0.0" }
        }
      });
      continue;
    }
    if (message.method === "ping" || message.method === "shutdown") {
      send({ jsonrpc: "2.0", id: message.id, result: {} });
      continue;
    }
    if (message.method === "tools/list") {
      send({ jsonrpc: "2.0", id: message.id, result: { tools: TOOL_DEFINITIONS } });
      continue;
    }
    if (message.method === "tools/call") {
      const name = message.params?.name;
      const handler = tools[name];
      if (!handler) {
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: { isError: true, content: [{ type: "text", text: "Unknown or disabled filesystem tool." }] }
        });
        continue;
      }
      try {
        const result = await handler(message.params?.arguments ?? {});
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: false }
        });
      } catch (error) {
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            content: [{ type: "text", text: error instanceof Error ? error.message : "Filesystem request failed." }],
            isError: true
          }
        });
      }
      continue;
    }
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: "Method not found." }
    });
  }
}

function isCurrentEntryPoint(candidate) {
  if (!candidate) return false;
  try {
    // Node canonicalizes import.meta.url to the real file path. The factory
    // runtime is a symlink, so compare canonical paths for both argv[1] and
    // the environment-resolved entrypoint instead of their lexical aliases.
    return pathToFileURL(realpathSync(candidate)).href === import.meta.url;
  } catch {
    return false;
  }
}

const isDirectEntryPoint = isCurrentEntryPoint(process.argv[1]);
const isConfiguredEntryPoint = isCurrentEntryPoint(process.env.FACTORY_FILESYSTEM_MCP_ENTRYPOINT);
if (isDirectEntryPoint || isConfiguredEntryPoint) {
  runMcpServer().catch((error) => {
    process.stderr.write("[factory-filesystem] " + (error instanceof Error ? error.message : String(error)) + "\n");
    process.exitCode = 1;
  });
}

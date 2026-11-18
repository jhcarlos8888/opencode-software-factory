import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { test } from "node:test";
import { createProjectFilesystem } from "../.opencode/mcp/factory-filesystem.mjs";

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "factory-filesystem-mcp-"));
  const project = join(base, "project");
  const outside = join(base, "outside");
  await mkdir(project);
  await mkdir(outside);
  await mkdir(join(project, "src"));
  await mkdir(join(project, ".git"));
  await mkdir(join(project, "node_modules"));
  await writeFile(join(project, "README.md"), "# Example\nfactory filesystem safe search\n");
  await writeFile(join(project, "src", "App.java"), "class App {\n  String message = \"factory filesystem safe search\";\n}\n");
  await writeFile(join(project, ".env"), "TOKEN=must-never-be-read\n");
  await writeFile(join(project, ".git", "config"), "secret git config\n");
  await writeFile(join(project, "node_modules", "dependency.js"), "ignored dependency\n");
  await writeFile(join(outside, "outside.txt"), "OUTSIDE-SECRET-MUST-NOT-LEAK\n");
  await symlink(outside, join(project, "linked"), "dir");
  await symlink(join(project, "src", "App.java"), join(project, "src", "AppAlias.java"));
  return { base, project, outside };
}

test("list_files skips symlinks, sensitive files, Git metadata and dependency directories", async () => {
  const f = await fixture();
  try {
    const fs = await createProjectFilesystem(f.project);
    const result = await fs.listFiles({ path: ".", max_depth: 5, max_entries: 500 });
    const paths = result.entries.map((entry) => entry.path);
    assert.ok(paths.includes("README.md"));
    assert.ok(paths.includes("src/App.java"));
    assert.equal(paths.some((path) => path.startsWith(".git/")), false);
    assert.equal(paths.some((path) => path.startsWith("node_modules/")), false);
    assert.equal(paths.some((path) => path.startsWith("linked/")), false);
    assert.equal(paths.includes(".env"), false);
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test("read_file only opens existing non-sensitive files below the canonical root", async () => {
  const f = await fixture();
  try {
    const fs = await createProjectFilesystem(f.project);
    const read = await fs.readProjectFile({ path: "src/App.java" });
    assert.match(read.content, /class App/);
    assert.match(read.content, /factory filesystem safe search/);
    await assert.rejects(() => fs.readProjectFile({ path: ".env" }), /sensibles/);
    await assert.rejects(() => fs.readProjectFile({ path: ".git/config" }), /sensibles/);
    await assert.rejects(() => fs.readProjectFile({ path: "../outside/outside.txt" }), /relativa|fuera/);
    await assert.rejects(() => fs.readProjectFile({ path: "linked/outside.txt" }), /symlink|simbólicos|accesible/);
    await assert.rejects(() => fs.readProjectFile({ path: "src/AppAlias.java" }), /symlink|simbólicos|accesible/);
    await assert.rejects(() => fs.readProjectFile({ path: "/etc/passwd" }), /relativa/);
    await assert.rejects(() => fs.readProjectFile({ path: "not-found.txt" }), /no existe/);
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test("search_text performs literal search only inside the project and excludes sensitive paths", async () => {
  const f = await fixture();
  try {
    const fs = await createProjectFilesystem(f.project);
    const result = await fs.searchText({ query: "factory filesystem safe search", path: ".", max_results: 50 });
    assert.equal(result.count, 2);
    assert.deepEqual(result.matches.map((match) => match.path).sort(), ["README.md", "src/App.java"]);
    assert.equal(JSON.stringify(result).includes("OUTSIDE-SECRET"), false);
    assert.equal(JSON.stringify(result).includes("TOKEN=must-never"), false);
    assert.equal(JSON.stringify(result).includes("secret git config"), false);
    await assert.rejects(() => fs.searchText({ query: ".", path: "../outside" }), /relativa|fuera/);
    await assert.rejects(() => fs.searchText({ query: " ", path: "." }), /texto literal/);
    await assert.rejects(() => fs.searchText({ query: "x".repeat(257) }), /texto literal/);
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test("search_text respects result, depth, file and total-byte limits", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.project, "src", "Many.txt"), Array.from({ length: 20 }, (_, i) => "match-" + i).join("\n"));
    const fs = await createProjectFilesystem(f.project);
    const result = await fs.searchText({ query: "match-", max_results: 3 });
    assert.equal(result.count, 3);
    assert.equal(result.truncated, true);
    assert.ok(result.files_scanned <= 1500);
    assert.ok(result.bytes_scanned <= 20 * 1024 * 1024);
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test("the exact OpenCode environment-resolved launcher starts the MCP in the selected project root", async () => {
  const f = await fixture();
  try {
    const factoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
    // The installed runtime is a symlink to the repository. Test the exact
    // lexical path the Control Center passes to OpenCode and Claude Code.
    const runtimeAlias = join(f.base, "factory-runtime");
    await symlink(factoryRoot, runtimeAlias, "dir");
    const config = JSON.parse(await readFile(join(factoryRoot, "opencode.json"), "utf8"));
    const server = config.mcp?.servers?.factory_filesystem;
    assert.equal(server?.type, "local");
    assert.deepEqual(server?.command, ["node", "{env:FACTORY_FILESYSTEM_MCP_ENTRYPOINT}"]);
    assert.equal(server?.environment?.FACTORY_FILESYSTEM_MCP_ENTRYPOINT, "{env:FACTORY_FILESYSTEM_MCP_ENTRYPOINT}");

    const entryPoint = join(runtimeAlias, ".opencode", "mcp", "factory-filesystem.mjs");
    const resolvedCommand = server.command.map((part) =>
      part.replaceAll("{env:FACTORY_FILESYSTEM_MCP_ENTRYPOINT}", entryPoint)
    );
    const resolvedEnvironment = Object.fromEntries(
      Object.entries(server.environment).map(([key, value]) => [
        key,
        value.replaceAll("{env:FACTORY_FILESYSTEM_MCP_ENTRYPOINT}", entryPoint)
      ])
    );
    const child = spawn(resolvedCommand[0], resolvedCommand.slice(1), {
      cwd: f.project,
      env: { ...process.env, ...resolvedEnvironment },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let output = "";
    let errorOutput = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { errorOutput += chunk; });

    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05" }
    }) + "\n");
    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 2, method: "tools/list", params: {}
    }) + "\n");
    child.stdin.end();

    const [exitCode, exitSignal] = await once(child, "close");
    assert.equal(exitCode, 0, errorOutput || "Configured MCP launcher exited unsuccessfully: " + exitSignal);
    const responses = output.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(responses.length, 2, "configured launcher must answer both MCP requests before it exits");
    assert.equal(responses[0].result.serverInfo.name, "factory-filesystem");
    assert.deepEqual(
      responses[1].result.tools.map((tool) => tool.name).sort(),
      ["list_files", "read_file", "search_text"]
    );
    assert.match(responses[1].result.tools[0].description, /proyecto/i);
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test("the stdio MCP protocol exposes only the three safe read-only tools", async () => {
  const f = await fixture();
  try {
    const script = new URL("../.opencode/mcp/factory-filesystem.mjs", import.meta.url);
    const child = spawn(process.execPath, [fileURLToPath(script)], {
      cwd: f.project,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let output = "";
    let errorOutput = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { errorOutput += chunk; });

    const requests = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_text", arguments: { query: "factory filesystem safe search" } } }
    ];
    child.stdin.write(requests.map((request) => JSON.stringify(request)).join("\n") + "\n");
    child.stdin.end();
    const [exitCode, exitSignal] = await once(child, "close");
    assert.equal(exitCode, 0, errorOutput || "MCP child exited unsuccessfully: " + exitSignal);

    const responses = output.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(responses.length, 3);
    assert.equal(responses[0].id, 1);
    assert.equal(responses[0].result.serverInfo.name, "factory-filesystem");
    const tools = responses[1].result.tools.map((tool) => tool.name).sort();
    assert.deepEqual(tools, ["list_files", "read_file", "search_text"]);
    assert.equal(responses[2].id, 3);
    assert.equal(responses[2].result.isError, false);
    assert.match(responses[2].result.content[0].text, /README.md/);
    assert.equal(errorOutput.includes("Error:"), false);
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

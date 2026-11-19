import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { analyzeProject } from "./projects.js";

test("project analysis requires an absolute, trimmed path", async () => {
  await assert.rejects(() => analyzeProject("relative/project"), /ruta del proyecto debe ser absoluta/);
  await assert.rejects(() => analyzeProject(" /tmp "), /ruta del proyecto debe ser absoluta/);
  await assert.rejects(() => analyzeProject(""), /ruta del proyecto debe ser absoluta/);
});

test("project analysis canonicalizes a selected symlink directory", async () => {
  const base = await mkdtemp(join(tmpdir(), "factory-project-canonical-"));
  try {
    const target = join(base, "actual-project");
    const alias = join(base, "selected-project");
    await mkdir(target);
    await writeFile(join(target, "pom.xml"), "<project/>\n");
    await symlink(target, alias, "dir");

    const analysis = await analyzeProject(alias);
    assert.equal(analysis.path, resolve(target));
    assert.deepEqual(analysis.manifests, ["pom.xml"]);
    assert.ok(analysis.stacks.includes("Java / Maven"));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("project analysis ignores symlinked instruction files and source directories", async () => {
  const base = await mkdtemp(join(tmpdir(), "factory-project-symlink-"));
  try {
    const project = join(base, "project");
    const outside = join(base, "outside");
    await mkdir(project);
    await mkdir(outside);
    await mkdir(join(outside, "src"));
    await writeFile(join(outside, "README.md"), "private external instructions");
    await writeFile(join(outside, "src", "app.py"), "print('outside')\n");
    await symlink(join(outside, "README.md"), join(project, "README.md"));
    await symlink(join(outside, "src"), join(project, "src"), "dir");

    const analysis = await analyzeProject(project);
    assert.equal(analysis.instructions.includes("README.md"), false);
    assert.equal(analysis.stacks.includes("Python"), false);
    assert.equal(
      analysis.recommendations.some((item) => item.includes("README.md disponible")),
      false
    );
    assert.equal(analysis.path, resolve(project));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});


test("preflight depth controls the structural scan and discovers nested modules without following symlinks", async () => {
  const base = await mkdtemp(join(tmpdir(), "factory-project-depth-"));
  try {
    const project = join(base, "modular-project");
    const module = join(project, "packages", "billing", "service");
    await mkdir(module, { recursive: true });
    await writeFile(join(project, "package.json"), "{}\n");
    await writeFile(join(module, "pom.xml"), "<project/>\n");
    await writeFile(join(module, "BillingService.java"), "class BillingService {}\n");

    const quick = await analyzeProject(project, "quick");
    const deep = await analyzeProject(project, "deep");

    assert.equal(quick.projectStructure.depthLimit, 2);
    assert.equal(deep.projectStructure.depthLimit, 8);
    assert.equal(quick.projectStructure.modules.includes(join("packages", "billing", "service")), false);
    assert.ok(deep.projectStructure.modules.includes(join("packages", "billing", "service")));
    assert.ok(deep.manifests.includes("package.json"));
    assert.ok(deep.stacks.includes("Java / Maven"));
    assert.ok(deep.projectPlan.recommendedAgents.length >= quick.projectPlan.recommendedAgents.length);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

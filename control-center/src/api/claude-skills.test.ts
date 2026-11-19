import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildClaudeFactorySkillsSdkOptions, ensureClaudeFactorySkillsPlugin } from "./claude-skills.js";

async function fixture(): Promise<{ root: string; factory: string; state: string }> {
  const root = await mkdtemp(join(tmpdir(), "factory-claude-skills-"));
  const factory = join(root, "factory");
  const state = join(root, "state");
  await mkdir(join(factory, ".opencode", "skills", "alpha"), { recursive: true });
  await mkdir(join(factory, ".opencode", "skills", "beta", "references"), { recursive: true });
  await writeFile(join(factory, ".opencode", "skills", "alpha", "SKILL.md"), "---\nname: alpha\ndescription: Skill alpha\n---\n\n# Alpha\n");
  await writeFile(join(factory, ".opencode", "skills", "beta", "SKILL.md"), "---\nname: beta\ndescription: Skill beta\n---\n\n# Beta\n");
  await writeFile(join(factory, ".opencode", "skills", "beta", "references", "guide.md"), "reference");
  return { root, factory, state };
}

test("Claude plugin contains every factory Skill, supporting files and a non-empty stable digest", async () => {
  const f = await fixture();
  try {
    const plugin = await ensureClaudeFactorySkillsPlugin(f.factory, f.state);
    assert.deepEqual(plugin.skillIds, ["alpha", "beta"]);
    assert.equal(plugin.fileCount, 3);
    assert.ok(plugin.totalBytes > 0);
    assert.notEqual(plugin.digest, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    assert.equal(await readFile(join(plugin.path, "skills", "alpha", "SKILL.md"), "utf8"),
      await readFile(join(f.factory, ".opencode", "skills", "alpha", "SKILL.md"), "utf8"));
    assert.equal(await readFile(join(plugin.path, "skills", "beta", "references", "guide.md"), "utf8"), "reference");
    const manifest = JSON.parse(await readFile(join(plugin.path, ".factory-skills-manifest.json"), "utf8"));
    assert.deepEqual(manifest.skillIds, ["alpha", "beta"]);
    assert.equal(manifest.digest, plugin.digest);
    const pluginJson = JSON.parse(await readFile(join(plugin.path, ".claude-plugin", "plugin.json"), "utf8"));
    assert.equal(pluginJson.name, "factory-skills");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("refresh updates the plugin atomically and removes stale skill files", async () => {
  const f = await fixture();
  try {
    const first = await ensureClaudeFactorySkillsPlugin(f.factory, f.state);
    await writeFile(join(f.factory, ".opencode", "skills", "alpha", "SKILL.md"), "---\nname: alpha\n---\n\n# Alpha v2\n");
    await rm(join(f.factory, ".opencode", "skills", "beta"), { recursive: true, force: true });
    const second = await ensureClaudeFactorySkillsPlugin(f.factory, f.state);
    assert.deepEqual(second.skillIds, ["alpha"]);
    assert.notEqual(second.digest, first.digest);
    assert.match(await readFile(join(second.path, "skills", "alpha", "SKILL.md"), "utf8"), /Alpha v2/);
    assert.deepEqual(await readdir(join(second.path, "skills")), ["alpha"]);
    assert.equal((await readdir(f.state)).filter((name) => name.startsWith("factory-skills.staging-") || name.startsWith("factory-skills.backup-")).length, 0);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a failed refresh leaves the last known-good plugin intact", async () => {
  const f = await fixture();
  try {
    const original = await ensureClaudeFactorySkillsPlugin(f.factory, f.state);
    await symlink("/etc/passwd", join(f.factory, ".opencode", "skills", "alpha", "unsafe-link"));
    await assert.rejects(() => ensureClaudeFactorySkillsPlugin(f.factory, f.state), /enlace simbólico/);
    assert.equal(await readFile(join(original.path, "skills", "alpha", "SKILL.md"), "utf8"),
      await readFile(join(f.factory, ".opencode", "skills", "alpha", "SKILL.md"), "utf8"));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("an unrelated existing plugin directory is never overwritten", async () => {
  const f = await fixture();
  try {
    const pluginRoot = join(f.state, "factory-skills");
    await mkdir(pluginRoot, { recursive: true });
    await writeFile(join(pluginRoot, "do-not-touch.txt"), "owned by someone else");
    await assert.rejects(() => ensureClaudeFactorySkillsPlugin(f.factory, f.state), /no pertenece a la fábrica|no reconoce/);
    assert.equal(await readFile(join(pluginRoot, "do-not-touch.txt"), "utf8"), "owned by someone else");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("plugin state is rejected when it resolves inside the factory repository", async () => {
  const f = await fixture();
  try {
    await assert.rejects(() => ensureClaudeFactorySkillsPlugin(f.factory, join(f.factory, ".private-state")), /fuera del repositorio/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});


test("Claude SDK receives only the explicit factory plugin and all namespaced factory Skills", () => {
  assert.deepEqual(buildClaudeFactorySkillsSdkOptions({
    path: "/private/factory-skills",
    skillIds: ["continuous-workflow", "security-scan"],
    digest: "digest",
    skillDigests: {},
    fileCount: 2,
    totalBytes: 100
  }), {
    plugins: [{ type: "local", path: "/private/factory-skills", skipMcpDiscovery: true }],
    pluginDelivery: "initialize",
    skills: ["factory-skills:continuous-workflow", "factory-skills:security-scan"]
  });
});

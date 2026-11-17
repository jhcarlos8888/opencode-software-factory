import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  claudeToolPathIsAllowed,
  isSafeFilesystemGlob,
  OPENCODE_SENSITIVE_PATH_GLOBS,
  isSensitiveFilesystemPath,
  requireCanonicalProjectRoot,
  resolveProjectCandidate
} from "./filesystem-guards.js";

test("OpenCode permissions include the same hard-deny sensitive path families", () => {
  for (const pattern of [
    "**/.git/**", "**/.env*", "**/.ssh/**", "**/.aws/**",
    "**/.netrc", "**/.npmrc", "**/.pgpass", "**/credentials/**",
    "**/*.pem", "**/*.p12", "**/*.jks", "**/*.ppk"
  ]) {
    assert.ok(OPENCODE_SENSITIVE_PATH_GLOBS.includes(pattern as never), pattern);
  }
});

test("sensitive paths cover repository metadata and common credential stores", () => {
  const sensitive = [
    ".env", ".env.production", "config/.env.local", ".netrc", ".npmrc",
    ".pypirc", ".pgpass", ".my.cnf", ".htpasswd", ".envrc",
    ".git/config", ".git/objects/ab/cd", ".git/hooks/pre-commit",
    ".ssh/id_ed25519", ".aws/credentials", ".config/gcloud/credentials.db",
    "secrets/service.json", "config/credentials.json", "keys/private_key.pem",
    "certs/client.p12", "certs/truststore.jks", "token.txt", "github_api_key.txt"
  ];
  for (const path of sensitive) assert.equal(isSensitiveFilesystemPath(path), true, path);
});

test("ordinary source files and documentation are not classified as sensitive", () => {
  const safe = [
    "README.md", "src/main/java/App.java", "test/AppTest.java",
    "config/application.yaml", ".github/workflows/ci.yml",
    "src/tokenizer/TokenParser.java", "src/ApiKeyController.java"
  ];
  for (const path of safe) assert.equal(isSensitiveFilesystemPath(path), false, path);
});

test("glob patterns cannot target sensitive paths, repository metadata or traversal", () => {
  for (const pattern of [
    ".git/**", "**/.git/config", "**/.env*", "**/.ssh/**",
    "**/*token*", "**/*.pem", "../outside/**", "/etc/**", "~/.ssh/**",
    "**/credentials.json", "**/*"
  ]) {
    assert.equal(isSafeFilesystemGlob(pattern), false, pattern);
  }
  for (const pattern of [
    "src/**/*.java", "test/**/*.ts", "docs/*.md", "**/*.xml", ".github/workflows/*.yml"
  ]) {
    assert.equal(isSafeFilesystemGlob(pattern), true, pattern);
  }
});

test("execution root must remain the exact canonical directory selected at preflight", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-canonical-root-"));
  const target = join(root, "target");
  const alias = join(root, "alias");
  try {
    await mkdir(target);
    await symlink(target, alias, "dir");
    assert.equal(await requireCanonicalProjectRoot(target), target);
    await assert.rejects(() => requireCanonicalProjectRoot(alias), /ruta del proyecto dejó de ser canónica/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project path resolution blocks traversal and symlinks escaping the sandbox", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-path-guard-"));
  const project = join(root, "project");
  const external = join(root, "outside");
  try {
    await mkdir(project);
    await mkdir(external);
    await mkdir(join(project, "src"));
    await writeFile(join(project, "src", "App.java"), "class App {}");
    await writeFile(join(external, "secret.txt"), "private");
    await symlink(external, join(project, "linked"), "dir");

    assert.equal(await resolveProjectCandidate(project, "src/App.java"), join(project, "src", "App.java"));
    assert.equal(await resolveProjectCandidate(project, "../outside/secret.txt"), null);
    assert.equal(await resolveProjectCandidate(project, "linked/secret.txt"), null);
    assert.equal(await resolveProjectCandidate(project, "linked/new-secret.txt"), null);
    assert.equal(await resolveProjectCandidate(project, ""), null);
    assert.equal(await resolveProjectCandidate(project, "src/\0bad"), null);
    assert.equal(await resolveProjectCandidate(project, "x".repeat(5000)), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tool path guard blocks sensitive reads, glob enumeration and remote file URLs", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-tool-guard-"));
  const project = join(root, "project");
  try {
    await mkdir(project);
    await mkdir(join(project, "src"));
    await writeFile(join(project, "README.md"), "docs");
    await writeFile(join(project, ".env"), "secret");
    await mkdir(join(project, ".git"));

    assert.equal(await claudeToolPathIsAllowed(project, "Read", { file_path: "README.md" }), true);
    assert.equal(await claudeToolPathIsAllowed(project, "Read", { file_path: ".env" }), false);
    assert.equal(await claudeToolPathIsAllowed(project, "Read", { file_path: ".git/config" }), false);
    assert.equal(await claudeToolPathIsAllowed(project, "Glob", { path: ".", pattern: ".git/**" }), false);
    assert.equal(await claudeToolPathIsAllowed(project, "Glob", { path: ".", pattern: "**/*.java" }), true);
    assert.equal(await claudeToolPathIsAllowed(project, "Grep", { path: ".", glob: "**/.env*" }), false);
    assert.equal(await claudeToolPathIsAllowed(project, "Read", { file_path: "file:///etc/passwd" }), false);
    assert.equal(await claudeToolPathIsAllowed(project, "Read", { file_path: "file://remote-host/etc/passwd" }), false);
    assert.equal(await claudeToolPathIsAllowed(project, "Read", { file_path: "file://%E0%A4%A" }), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

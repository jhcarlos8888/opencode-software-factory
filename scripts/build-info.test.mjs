import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile, lstat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBuildInfo } from "../control-center/scripts/write-build-info.mjs";

test("build fingerprint is deterministic and changes when a runtime input changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-build-info-"));
  try {
    await mkdir(join(root, "src/api"), { recursive: true });
    await writeFile(join(root, "src/api/server.ts"), "export const port = 4141;\n");
    await writeFile(join(root, "package.json"), "{\"name\":\"test\"}\n");
    const inputs = ["src/api", "package.json"];
    const first = await createBuildInfo(root, { inputs, generatedAt: "2026-01-01T00:00:00.000Z" });
    const second = await createBuildInfo(root, { inputs, generatedAt: "2026-01-02T00:00:00.000Z" });
    assert.equal(first.buildId, second.buildId);
    assert.notEqual(first.generatedAt, second.generatedAt);
    await writeFile(join(root, "src/api/server.ts"), "export const port = 4142;\n");
    const changed = await createBuildInfo(root, { inputs });
    assert.notEqual(changed.buildId, first.buildId);
    assert.equal(changed.sourceFileCount, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("build fingerprint refuses a symlinked source input", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-build-info-link-"));
  const outside = await mkdtemp(join(tmpdir(), "factory-build-info-outside-"));
  try {
    await writeFile(join(outside, "external.ts"), "do not read through this link");
    await symlink(outside, join(root, "linked-source"));
    await assert.rejects(
      () => createBuildInfo(root, { inputs: ["linked-source"] }),
      /no admite symlinks/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("build fingerprint is written with private permissions and refuses symlink output", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-build-info-output-"));
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "server.ts"), "export {};\n");
    const output = join(root, "dist", "build-info.json");
    const { writeBuildInfo } = await import("../control-center/scripts/write-build-info.mjs");
    const info = await writeBuildInfo(root, output, { inputs: ["src"] });
    assert.equal((await lstat(output)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(output, "utf8")).buildId, info.buildId);

    const external = join(root, "external.json");
    const link = join(root, "linked-build-info.json");
    await writeFile(external, "external");
    await symlink(external, link);
    await assert.rejects(
      () => writeBuildInfo(root, link, { inputs: ["src"] }),
      /no es un archivo regular/
    );
    assert.equal(await readFile(external, "utf8"), "external");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

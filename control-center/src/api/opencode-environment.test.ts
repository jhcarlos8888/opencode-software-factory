import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOpenCodeChildPath, appendInstalledBunPath } from "./opencode-environment.js";

test("OpenCode child shells inherit CLI bin, Node and existing tools", () => {
  const value = buildOpenCodeChildPath(
    "/home/u/.nvm/bin", "/home/u/.opencode/bin/opencode", "/usr/bin:/bin", ":"
  );
  assert.deepEqual(value.split(":"), [
    "/home/u/.nvm/bin", "/home/u/.opencode/bin", "/usr/bin", "/bin"
  ]);
});

test("child PATH keeps precedence, removes duplicates and skips empties", () => {
  const value = buildOpenCodeChildPath(
    "/node/bin", "/tools/opencode", ":/tools:/usr/bin:/tools::/node/bin", ":"
  );
  assert.equal(value, "/node/bin:/tools:/usr/bin");
});

test("child PATH remains valid without an inherited value", () => {
  assert.equal(buildOpenCodeChildPath("/node/bin", "/opencode/bin/opencode", undefined, ":"),
    "/node/bin:/opencode/bin");
});

test("Bun is appended only from the installed executable and does not override inherited PATH", () => {
  const home=realpathSync(mkdtempSync(join(tmpdir(),"factory-bun-")));
  try {
    const bin=join(home,".bun/bin");
    mkdirSync(bin,{recursive:true});
    assert.equal(appendInstalledBunPath("/usr/bin",home,":"),"/usr/bin");
    writeFileSync(join(bin,"bun"),"fixture",{mode:0o755});
    assert.equal(appendInstalledBunPath("/usr/bin",home,":"),"/usr/bin:"+bin);
    assert.equal(appendInstalledBunPath("/usr/bin:"+bin,home,":"),"/usr/bin:"+bin);
    rmSync(join(bin,"bun"));
    symlinkSync("/bin/sh",join(bin,"bun"));
    assert.equal(appendInstalledBunPath("/usr/bin",home,":"),"/usr/bin");
  } finally {rmSync(home,{recursive:true,force:true});}
});

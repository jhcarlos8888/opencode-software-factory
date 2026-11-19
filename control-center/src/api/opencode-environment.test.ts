import assert from "node:assert/strict";
import test from "node:test";
import { buildOpenCodeChildPath } from "./opencode-environment.js";

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

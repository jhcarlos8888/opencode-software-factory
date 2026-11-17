import assert from "node:assert/strict";
import { test } from "node:test";
import { buildOpenCodePermissionRules, type OpenCodePermissionProfile } from "./opencode-permissions.js";

function finalRule(profile: OpenCodePermissionProfile, action: string, resource = "*") {
  const rules = buildOpenCodePermissionRules(profile).filter((rule) =>
    rule.action === action && rule.resource === resource
  );
  return rules.at(-1)?.effect;
}

for (const profile of ["read-only", "workspace-write", "approval-required"] as const) {
  test(profile + " cannot use native unscoped filesystem discovery", () => {
    for (const action of ["read", "glob", "grep", "list", "lsp", "external_directory"]) {
      assert.equal(finalRule(profile, action), "deny", action);
    }
  });

  test(profile + " can use only the local factory filesystem MCP for reading and searching", () => {
    assert.equal(finalRule(profile, "factory_filesystem_*"), "allow");
    assert.equal(finalRule(profile, "skill"), "allow");
  });

  test(profile + " denies writes to credential stores and repository metadata", () => {
    for (const action of ["edit", "write", "patch"]) {
      assert.equal(finalRule(profile, action, "**/.git/**"), "deny");
      assert.equal(finalRule(profile, action, "**/.env*"), "deny");
      assert.equal(finalRule(profile, action, "**/*.pem"), "deny");
      assert.equal(finalRule(profile, action, "**/credentials/**"), "deny");
    }
  });
}

test("read-only denies all write and command execution actions", () => {
  for (const action of ["edit", "write", "patch", "shell", "subagent"]) {
    assert.equal(finalRule("read-only", action), "deny", action);
  }
});

test("workspace-write allows project edits but never shell or nested delegation without approval", () => {
  assert.equal(finalRule("workspace-write", "edit"), "allow");
  assert.equal(finalRule("workspace-write", "shell"), "ask");
  assert.equal(finalRule("workspace-write", "subagent"), "deny");
});

test("approval-required profile asks before edits and shell commands", () => {
  assert.equal(finalRule("approval-required", "edit"), "ask");
  assert.equal(finalRule("approval-required", "shell"), "ask");
  assert.equal(finalRule("approval-required", "subagent"), "ask");
});

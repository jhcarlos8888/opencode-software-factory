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

test("workspace-write allows create, edit and patch in the project while shell and delegation stay protected", () => {
  for (const action of ["edit", "write", "patch"]) {
    assert.equal(finalRule("workspace-write", action), "allow", action);
  }
  assert.equal(finalRule("workspace-write", "shell"), "ask");
  assert.equal(finalRule("workspace-write", "subagent"), "deny");
});

test("approval-required profile asks before edits and shell commands", () => {
  assert.equal(finalRule("approval-required", "edit"), "ask");
  assert.equal(finalRule("approval-required", "shell"), "ask");
  assert.equal(finalRule("approval-required", "subagent"), "ask");
});

test("source-only audit uses a closed allowlist instead of asking about external MCP resources", () => {
  const rules = buildOpenCodePermissionRules("read-only", true);
  assert.equal(rules[0]?.effect, "deny");
  const allowed = rules.filter(r => r.effect === "allow").map(r => r.action);
  assert.deepEqual(allowed, ["skill", "factory_filesystem_list_files", "factory_filesystem_read_file",
    "factory_filesystem_search_text", "factory_filesystem_summarize_junit"]);
  assert.equal(rules.some(r => r.effect === "ask"), false);
  for (const action of ["shell", "write", "subagent", "opencode_list_mcp_resources",
    "opencode_read_mcp_resource", "webfetch", "rea_query", "playwright_browser_click", "execute"]) {
    assert.equal(allowed.includes(action), false, action);
  }
});

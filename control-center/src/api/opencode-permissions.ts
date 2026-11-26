import { OPENCODE_SENSITIVE_PATH_GLOBS } from "./filesystem-guards.js";

export type OpenCodePermissionProfile = "read-only" | "workspace-write" | "approval-required";
export type PermissionEffect = "allow" | "ask" | "deny";
export interface OpenCodePermissionRule {
  action: string;
  resource: string;
  effect: PermissionEffect;
}

/**
 * Session-level OpenCode permissions override broad factory/user config rules.
 * Therefore every hard boundary must be present here as well as in
 * opencode.json. Native filesystem discovery is deliberately disabled because
 * V2 authorizes Glob by pattern and Grep by regex rather than by search path.
 */
export function buildOpenCodePermissionRules(
  profile: OpenCodePermissionProfile, sourceOnly = false
): OpenCodePermissionRule[] {
  const rules: OpenCodePermissionRule[] = [
    { action: "*", resource: "*", effect: "ask" },
    { action: "skill", resource: "*", effect: "allow" },
    { action: "factory_filesystem_*", resource: "*", effect: "allow" }
  ];

  if (profile === "read-only") {
    for (const action of ["edit", "write", "patch", "shell", "subagent"]) {
      rules.push({ action, resource: "*", effect: "deny" });
    }
  } else if (profile === "workspace-write") {
    for (const action of ["edit", "write", "patch"]) {
      rules.push({ action, resource: "*", effect: "allow" });
    }
    rules.push({ action: "shell", resource: "*", effect: "ask" });
    rules.push({ action: "subagent", resource: "*", effect: "deny" });
  } else if (profile === "approval-required") {
    for (const action of ["edit", "write", "patch", "shell", "subagent"]) {
      rules.push({ action, resource: "*", effect: "ask" });
    }
  }

  // Hard boundaries are appended after profile rules: OpenCode V2 uses
  // last-match-wins evaluation.
  for (const action of ["read", "glob", "grep", "list", "lsp", "external_directory"]) {
    rules.push({ action, resource: "*", effect: "deny" });
  }
  for (const resource of OPENCODE_SENSITIVE_PATH_GLOBS) {
    for (const action of ["edit", "write", "patch"]) {
      rules.push({ action, resource, effect: "deny" });
    }
  }

  if (sourceOnly) {
    // The audit has no authority for arbitrary tools, external MCP resources,
    // web calls, process execution or mutation. The factory MCP itself checks paths.
    return [
      { action: "*", resource: "*", effect: "deny" },
      { action: "skill", resource: "*", effect: "allow" },
      ...["list_files", "read_file", "search_text", "summarize_junit"].map(
        name => ({ action: "factory_filesystem_" + name, resource: "*", effect: "allow" as const })),
    ];
  }
  return rules;
}

import assert from "node:assert/strict";
import test from "node:test";
import { assessAuditorTool, assessOpenCodePermission, isProtectedShellCommand } from "./auditor-policy.js";

const projectPath = "/home/user/projects/aula";
function claude(toolName: string, input: Record<string, unknown>, permissionProfile: "read-only" | "workspace-write" | "approval-required" = "workspace-write") {
  return assessAuditorTool({ engine: "claude", toolName, input, projectPath, permissionProfile });
}
function opencode(action: string, input: Record<string, unknown>, permissionProfile: "read-only" | "workspace-write" | "approval-required" = "workspace-write") {
  return assessOpenCodePermission({ action, metadata: { input }, resources: ["*"], save: ["*"] }, projectPath, permissionProfile);
}

test("Auditor approves narrow, real check commands automatically", () => {
  for (const command of ["git status --porcelain", "git diff --stat", "git diff --unified=0 public/styles.css",
    "git status -sb", "npm run check", "npm run test:unit", "npm run smoke", "bash scripts/smoke-test.sh",
    "node --check public/app.js", "ss -ltnp", "pwd"]) {
    assert.equal(claude("Bash", { command }).verdict, "auto", command);
    assert.equal(opencode("shell", { command }).verdict, "auto", command);
  }
});

test("Auditor refuses to auto approve risky process control (incident regression)", () => {
  for (const command of [
    "pkill -f 'node server.js'", "kill 301397", "killall node", "fuser -k 4173/tcp",
    "systemctl --user stop aula-research-studio.service", "sudo systemctl restart docker",
    "rm -rf public", "git reset --hard", "git clean -fdx", "docker kill aula", "podman rm aula"
  ]) {
    assert.equal(isProtectedShellCommand(command), true, command);
    assert.equal(claude("Bash", { command }).verdict, "block", command);
    assert.equal(opencode("shell", { command }).verdict, "block", command);
  }
});

test("No shell injection or unreviewed Git publishing is auto approved", () => {
  for (const command of [
    "npm run check; rm -rf data", "git status && kill 301397",
    "git diff | bash", "git status $(touch /tmp/pwned)",
    "git diff --stat > public/index.html", "git commit -am 'change'",
    "git push origin master", "npm start", "npm install",
    "curl -X POST http://localhost:4173/api/projects",
    "bash scripts/custom-test.sh", "git diff --output=/tmp/untrusted"
  ]) assert.notEqual(claude("Bash", { command }).verdict, "auto", command);
});

test("Read-only and approval-required agents never gain automatic shell authority", () => {
  for (const profile of ["read-only", "approval-required"] as const) {
    assert.notEqual(claude("Bash", { command: "npm run smoke" }, profile).verdict, "auto");
    assert.notEqual(opencode("shell", { command: "git status" }, profile).verdict, "auto");
  }
});

test("Auto approval requires in-project working directory", () => {
  assert.equal(claude("Bash", { command: "npm run smoke", cwd: "/etc" }).verdict, "human");
  assert.equal(opencode("shell", { command: "npm run smoke", workdir: "../another-project" }).verdict, "human");
  assert.equal(claude("Bash", { command: "npm run smoke", cwd: projectPath }).verdict, "auto");
});

test("Safe local browser operations avoid extra permission clicks", () => {
  for (const [toolName,input] of [
    ["playwright_browser_navigate", { url: "http://127.0.0.1:4173/" }],
    ["playwright_browser_navigate", { url: "http://localhost:4173/api/health" }],
    ["playwright_browser_resize", { width: 390, height: 844 }],
    ["playwright_browser_console_messages", { level: "warning" }],
    ["playwright_browser_take_screenshot", {}],
    ["playwright_browser_snapshot", {}]
  ] as const) assert.equal(opencode(toolName, input).verdict, "auto", toolName);
  for (const [toolName,input] of [
    ["playwright_browser_evaluate", { function: "() => fetch('/api/delete', {method:'POST'})" }],
    ["playwright_browser_click", { ref: "delete-project" }],
    ["playwright_browser_navigate", { url: "https://somewhere.test/" }],
    ["playwright_browser_navigate", { url: "http://127.0.0.1:4173/api/projects/delete" }],
    ["playwright_browser_take_screenshot", { filename: "../.ssh/key.png" }]
  ] as const) assert.notEqual(opencode(toolName, input).verdict, "auto", toolName);
});

test("Real OpenCode V2 segmented shell resources are validated individually", () => {
  const decide = (resources: string[]) =>
    assessOpenCodePermission({ action: "shell", resources, save: ["*"] }, projectPath, "workspace-write");
  assert.equal(decide(["npm run check"]).verdict, "auto");
  assert.equal(decide(["git status --porcelain", "git diff --stat"]).verdict, "auto");
  assert.equal(decide(["npm run smoke"]).verdict, "auto");
  assert.equal(decide(["pkill -f 'node server.js'", "sleep 1", "curl -sf localhost:4173"]).verdict, "block");
  assert.equal(decide(["ss -ltnp", "kill 301397"]).verdict, "block");
  assert.equal(decide(["npm run check 2>&1", "echo EXIT=$?"]).verdict, "human");
  assert.equal(decide(["*"]).verdict, "human");
  assert.equal(decide([]).verdict, "human");
});

test("No authority from save wildcard without concrete commands", () => {
  assert.equal(assessOpenCodePermission({ action: "shell", save: ["*"] }, projectPath, "workspace-write").verdict, "human");
  assert.equal(opencode("shell", { command: "kill 301397" }).verdict, "block");
});

test("Auditor handles OpenCode's real read-only compound commands without manual clicks", () => {
  const workloads: string[][] = [
    ["git status --porcelain", "echo '---BRANCH---'", "git branch --show-current", "git rev-parse HEAD"],
    ["git diff --check", 'echo "CHECK_EXIT=$?"'],
    ["npm run check 2>&1", "tail -5", 'echo "EXIT=${PIPESTATUS[0]}"'],
    ["npm run test:unit 2>&1", "tail -8", 'echo "EXIT=${PIPESTATUS[0]}"'],
    ["npm run smoke 2>&1", "tail -12", 'echo "EXIT=${PIPESTATUS[0]}"'],
    ["git status", "echo '---'", "git status -sb", "head -1", "git log origin/master -1 --format='%H %s'"],
    ["git status --porcelain", 'echo "---BRANCH---"', "git status -sb", 'echo "---LOG---"', "git log --oneline -3", 'echo "---REMOTE---"', "git rev-parse origin/master"],
  ];
  for (const resources of workloads) {
    const verdict = assessOpenCodePermission({ action: "shell", resources, save: ["*"] }, projectPath, "workspace-write");
    assert.equal(verdict.verdict, "auto", resources.join(" | "));
  }
});

test("Auditor's compound-shell support cannot be turned into arbitrary execution", () => {
  for (const resources of [
    ["npm run check 2>&1", "tail -12", "rm -rf data"],
    ["git status", "echo '---BRANCH---'; kill 1234"],
    ['echo "EXIT=${HOME}"'],
    ['echo "$(cat /etc/passwd)"'],
    ["npm run check 2>/tmp/stealth"],
    ["git status | sh"],
    ["git log --oneline -3; curl bad.test"],
    ["git diff --check", "head -1 /etc/shadow"],
    ["npm run check 2>&1", "tail -12", "git push --force origin master"],
  ]) {
    const verdict = assessOpenCodePermission({ action: "shell", resources }, projectPath, "workspace-write");
    assert.notEqual(verdict.verdict, "auto", resources.join(" | "));
  }
});

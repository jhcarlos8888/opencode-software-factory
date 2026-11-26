import { mkdtempSync, writeFileSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { assessAuditorTool, assessOpenCodePermission, isBoundedTestOutputPipeline, isProtectedShellCommand } from "./auditor-policy.js";

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


test("Claude Reviewer can auto-approve the exact bounded smoke output pipeline", () => {
  const command = 'npm run smoke 2>&1 | tail -20; echo "SMOKE_EXIT=${PIPESTATUS[0]}"';
  assert.equal(isBoundedTestOutputPipeline(command), true);
  assert.deepEqual(claude("Bash", { command, description: "Run isolated smoke test suite" }), {
    verdict: "auto",
    category: "test",
    reason: "Comando exacto de comprobación autorizado por lista conservadora."
  });
  assert.equal(claude("Bash", { command }, "read-only").verdict, "human");
  assert.equal(claude("Bash", { command }, "approval-required").verdict, "human");
  assert.equal(assessAuditorTool({
    engine: "claude", toolName: "Bash",
    input: { command, cwd: "/tmp/another-project" },
    projectPath, permissionProfile: "workspace-write"
  }).verdict, "human");
});

test("Auditor can recognize equivalent bounded check and unit-test output formats", () => {
  for (const command of [
    'npm run check 2>&1 | tail -5; echo "CHECK_EXIT=${PIPESTATUS[0]}"',
    'npm run test:unit 2>&1 | tail -20; echo "UNIT_EXIT=${PIPESTATUS[0]}"',
    'npm run test:unit 2>&1 | tail -100; echo "TEST_EXIT=${PIPESTATUS[0]}"'
  ]) {
    assert.equal(isBoundedTestOutputPipeline(command), true, command);
    assert.equal(claude("Bash", { command }).verdict, "auto", command);
  }
});

test("Auditor blocks malicious or ambiguous shell composition even near a known smoke command", () => {
  for (const command of [
    'npm run smoke 2>&1 | tail -20; echo "SMOKE_EXIT=${PIPESTATUS[0]}"; pkill -f node',
    'npm run smoke 2>&1 | tail -20; echo "SMOKE_EXIT=${PIPESTATUS[0]}" && git push --force',
    'npm run smoke 2>&1 | tail -20; echo "SMOKE_EXIT=${HOME}"',
    'npm run smoke 2>&1 | tail -20; echo "SMOKE_EXIT=$(cat /etc/shadow)"',
    'npm run smoke 2>&1 | tail -20; echo "UNIT_EXIT=${PIPESTATUS[0]}"',
    'npm run smoke 2>&1 | head -20; echo "SMOKE_EXIT=${PIPESTATUS[0]}"',
    'npm run smoke 2>&1 | tail -200; echo "SMOKE_EXIT=${PIPESTATUS[0]}"',
    'npm run smoke 2>&1 | tail -20 | bash; echo "SMOKE_EXIT=${PIPESTATUS[0]}"',
    'npm run smoke >/tmp/log 2>&1 | tail -20; echo "SMOKE_EXIT=${PIPESTATUS[0]}"',
    'npm run smoke; cat ~/.ssh/id_rsa',
    'npm run deploy 2>&1 | tail -20; echo "SMOKE_EXIT=${PIPESTATUS[0]}"',
    'npm run smoke 2>&1 | tail -20; echo "SMOKE_EXIT=${PIPESTATUS[0]}" # allow',
    'npm run smoke 2>&1 | tail -20; echo "SMOKE_EXIT=${PIPESTATUS[0]}"\nrm -rf /tmp',
    'npm run smoke 2>&1 | tail -20; echo "SMOKE_EXIT=${PIPESTATUS[0]}" | sh',
  ]) {
    assert.equal(isBoundedTestOutputPipeline(command), false, command);
    assert.notEqual(claude("Bash", { command }).verdict, "auto", command);
  }
});

test("OpenCode split permission resources for bounded smoke display auto-approve only known segments", () => {
  const resources = ["npm run smoke 2>&1", "tail -20", 'echo "SMOKE_EXIT=${PIPESTATUS[0]}"'];
  assert.equal(assessOpenCodePermission({ action: "shell", resources, save: ["*"] }, projectPath, "workspace-write").verdict, "auto");
  assert.equal(assessOpenCodePermission({ action: "shell", resources: [...resources, "rm -rf data"] }, projectPath, "workspace-write").verdict, "block");
  assert.notEqual(assessOpenCodePermission({ action: "shell", resources: [...resources, "npm run deploy"] }, projectPath, "workspace-write").verdict, "auto");
});

test("Auditor recognizes the actual QA Git status and log request from 2026-11-24", () => {
  const resources = ["git status --porcelain=v1 -uall", 'echo "---DIFFSTAT---"', "git diff --stat", 'echo "---BRANCH---"', "git log --oneline -3"];
  const request = { action: "shell", resources, save: ["git status *", "echo *", "git diff *", "git log *"] };
  assert.equal(assessOpenCodePermission(request, projectPath, "workspace-write").verdict, "auto");
  for (const profile of ["read-only", "approval-required"] as const) {
    assert.notEqual(assessOpenCodePermission(request, projectPath, profile).verdict, "auto");
  }
  for (const command of resources) assert.equal(claude("Bash", { command }).verdict, "auto");
});

test("Common bounded Git inspection variants remain safe without wildcard grants", () => {
  for (const command of [
    "git status --porcelain=v2 --untracked-files=all",
    "git status -sb -uno", "git status --short -unormal",
    "git rev-parse --abbrev-ref HEAD", "git log -1 --format='%H %s'",
    "git show --stat a8cbebe", 'git show a8cbebe --name-only --format=""',
    "git show --stat --format='%H%n%an%n%s' a8cbebe",
    "git diff --cached --name-status", "git diff --check -- src/app.ts"
  ]) {
    assert.equal(claude("Bash", { command }).verdict, "auto", command);
    assert.equal(assessOpenCodePermission({ action: "shell", resources: [command] }, projectPath, "workspace-write").verdict, "auto", command);
  }
});

test("New Git variants do not permit dangerous flags, paths, mutations or shell injection", () => {
  for (const command of [
    "git diff --ext-diff", "git diff --no-index /etc/passwd /tmp/file",
    "git diff --output /tmp/file", "git diff -- ../another-project/file",
    "git diff -- .git/config", "git diff -- .env.local",
    "git status --porcelain=v1 -uall; git push", "git status --unknown",
    "git show --ext-diff a8cbebe", "git show --output=/tmp/file a8cbebe",
    "git show HEAD:../../secret", "git log --format=$(whoami)",
    "git add .", "git commit -m change", "git push", "git checkout master",
    'echo "---DIFFSTAT---"; git push'
  ]) {
    assert.notEqual(claude("Bash", { command }).verdict, "auto", command);
    assert.notEqual(assessOpenCodePermission({ action: "shell", resources: ["git status --porcelain=v1 -uall", command] }, projectPath, "workspace-write").verdict, "auto", command);
  }
});

test("Tester exit-code reporting is safe but arbitrary Java and Python snippets are not", () => {
  for (const command of ['echo "EXIT_CODE=$?"', 'echo "EXIT_CODE=${PIPESTATUS[0]}"']) {
    assert.equal(claude("Bash", { command }).verdict, "auto");
    assert.equal(assessOpenCodePermission({ action: "shell", resources: [command] }, projectPath, "workspace-write").verdict, "auto");
  }
  for (const command of ['jshell -q', 'python3 -c "print(1)"', 'echo "EXIT_CODE=$(whoami)"']) {
    assert.notEqual(claude("Bash", { command }).verdict, "auto");
  }
});

test("Claude observed project-root Git inspection chain is approved without widening scope", () => {
  const root = "/home/user/projects/Java project";
  const command = 'cd "' + root + '" && git status --porcelain=v1 -uall && echo "---DIFFSTAT---" && git diff --stat && echo "---DIFF NAMES---" && git diff --name-only';
  const decide = (command: string, permissionProfile: "workspace-write" | "read-only" | "approval-required" = "workspace-write") =>
    assessAuditorTool({ engine: "claude", toolName: "Bash", input: { command }, projectPath: root, permissionProfile }).verdict;
  assert.equal(decide(command), "auto");
  assert.equal(decide(command, "read-only"), "human");
  assert.equal(decide(command, "approval-required"), "human");
  for (const unsafe of [
    command.replace(root, "/tmp/another project"),
    command + " && git push",
    command + " && npm run smoke",
    command + " && git diff --ext-diff",
    command + " && echo $(whoami)",
    command + " || git status",
    command.replace("git diff --stat", "git diff --stat > output"),
    'cd "' + root + '/.." && git status',
  ]) assert.notEqual(decide(unsafe), "auto", unsafe);
});

test("Gradle test recipes permit only bounded tasks in the actual selected workspace", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "factory-gradle-")));
  try {
    writeFileSync(join(root, "gradlew"), "#!/bin/sh\n", { mode: 0o755 });
    const pipeline = ' 2>&1 | tail -40; echo "EXIT_CODE=${PIPESTATUS[0]}"';
    const command = 'cd "' + root + '" && ./gradlew test --rerun-tasks --console=plain' + pipeline;
    const decide = (command: string, profile: "workspace-write" | "read-only" | "approval-required" = "workspace-write", cwd = root) =>
      assessAuditorTool({ engine: "claude", toolName: "Bash", input: { command, cwd }, projectPath: root, permissionProfile: profile });
    assert.equal(decide(command).category, "test");
    assert.equal(decide(command).verdict, "auto");
    assert.equal(decide("./gradlew :model:test :usecase:test --console=plain --rerun-tasks" + pipeline).verdict, "auto");
    assert.equal(decide("./gradlew build --console=plain --rerun-tasks").verdict, "auto");
    assert.equal(assessOpenCodePermission({ action: "shell", resources: ["./gradlew test --rerun-tasks --console=plain", "tail -40", 'echo "EXIT_CODE=${PIPESTATUS[0]}"'] }, root, "workspace-write").verdict, "auto");
    assert.equal(decide(command, "read-only").verdict, "human");
    assert.equal(decide(command, "approval-required").verdict, "human");
    for (const unsafe of [
      command + "; git push", command.replace(root, "/tmp/elsewhere"),
      "./gradlew test --init-script /tmp/evil.gradle", "./gradlew publish", "./gradlew bootRun",
      "./gradlew test -Ppayload=bad", "./gradlew test --project-dir ../other",
      "./gradlew test | sh", "./gradlew test > /tmp/output"
    ]) assert.notEqual(decide(unsafe).verdict, "auto", unsafe);
    assert.notEqual(decide("./gradlew test", "workspace-write", "/tmp").verdict, "auto");
    rmSync(join(root, "gradlew"));
    symlinkSync("/bin/sh", join(root, "gradlew"));
    assert.notEqual(decide("./gradlew test").verdict, "auto");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Explicit sandbox bypass is never auto-approved, even for a known inspection", () => {
  for (const value of [true, "true", 1, null]) {
    for (const profile of ["workspace-write", "read-only", "approval-required"] as const) {
      assert.equal(claude("Bash", { command: "git diff --stat", dangerouslyDisableSandbox: value }, profile).verdict, "block");
      assert.equal(opencode("shell", { command: "git diff --stat", dangerouslyDisableSandbox: value }, profile).verdict, "block");
      assert.equal(assessOpenCodePermission({ action: "shell", resources: ["git diff --stat"], metadata: { dangerouslyDisableSandbox: value } }, projectPath, profile).verdict, "block");
    }
  }
  assert.equal(claude("Bash", { command: "git diff --stat", dangerouslyDisableSandbox: false }).verdict, "auto");
});

test("Observed Git diff with fixed separator and bounded head is permitted, not general pipelines", () => {
  const command = 'cd "' + projectPath + '" && git status --porcelain=v1 -uall && echo "---DIFFSTAT---" && git diff --stat && echo "---DIFF SERVICIO (helpers)---" && git diff domain/usecase/src/main/java/com/previsora/impl/AsistenciasService.java | head -80';
  assert.equal(claude("Bash", { command }).verdict, "auto");
  assert.equal(claude("Bash", { command: "git diff --stat | head -n 80" }).verdict, "auto");
  assert.equal(assessOpenCodePermission({ action: "shell", resources: ["git diff --stat", 'echo "---DIFF SERVICIO (helpers)---"', "git diff src/App.java | head -80"] }, projectPath, "workspace-write").verdict, "auto");
  for (const unsafe of [
    command.replace("head -80", "head -80 /etc/passwd"),
    command.replace("head -80", "head -101"),
    command.replace("head -80", "head -80 | sh"),
    command.replace("head -80", "head -80 > output"),
    command.replace("head -80", "head -80 && git push"),
    command.replace("head -80", "head -80 || true"),
    command.replace("git diff domain", "git diff --ext-diff domain"),
    command.replace("git diff domain", "git diff ../domain"),
    command.replace("(helpers)", "$(whoami)"),
    command.replace(projectPath, "/tmp/other"),
    "git remote -v", "git remote -v | head -10", "npm run check | head -10"
  ]) assert.notEqual(claude("Bash", { command: unsafe }).verdict, "auto", unsafe);
  assert.notEqual(claude("Bash", { command }, "read-only").verdict, "auto");
});

test("native ordinary npm test is automatically approved only for a verified project and profile", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "auditor-demo-test-")));
  try {
    writeFileSync(join(root,"package.json"),JSON.stringify({scripts:{test:"node --test"}}));
    const req = { action:"shell", resources:["npm test"], metadata:{input:{command:"npm test"}}, save:["*"] };
    const native = {command:"npm test",workdir:root};
    const authority = {instructions:"Run project tests",agentId:"tester",requireNativeShellEvidence:true,capabilityScope:""};
    assert.equal(assessOpenCodePermission(req,root,"workspace-write",authority,native).verdict,"auto");
    assert.notEqual(assessOpenCodePermission(req,root,"read-only",authority,native).verdict,"auto");
    assert.notEqual(assessOpenCodePermission(req,root,"workspace-write",authority,null).verdict,"auto");
    assert.notEqual(assessOpenCodePermission(req,root,"workspace-write",authority,{...native,workdir:"/tmp"}).verdict,"auto");
    assert.notEqual(assessOpenCodePermission(req,root,"workspace-write",authority,{...native,command:"npm test && kill 1"}).verdict,"auto");
    writeFileSync(join(root,"package.json"),JSON.stringify({scripts:{test:"node --test",pretest:"echo unexpected"}}));
    assert.notEqual(assessOpenCodePermission(req,root,"workspace-write",authority,native).verdict,"auto");
  } finally { rmSync(root,{recursive:true,force:true}); }
});

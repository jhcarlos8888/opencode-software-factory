import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync, rmSync, symlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assessOpenCodePermission, assessAuditorTool } from "./auditor-policy.js";
import { gitRoundAuthorization, findNativeGitToolInput, nativeGitCommandMatches } from "./git-workflow-policy.js";

const authority = { agentId: "implementer", instructions: "Por favor hagamos commit y push de los cambios que se han hecho en el proyecto autogestion" };
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "factory-git-policy-")));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], {encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
  git("init","-b","juanHerrera#RefactorCode");
  git("config","user.name","Factory Test"); git("config","user.email","test@example.invalid");
  git("config","commit.gpgsign","false"); git("config","core.hooksPath","/dev/null");
  mkdirSync(join(root,"src"));
  writeFileSync(join(root,"src","A.java"),"class A {}\n");
  git("add","src/A.java"); git("commit","-m","initial");
  git("remote","add","origin","https://github.com/example/example.git");
  git("update-ref","refs/remotes/origin/juanHerrera#RefactorCode","HEAD");
  git("config","branch.juanHerrera#RefactorCode.remote","origin");
  git("config","branch.juanHerrera#RefactorCode.merge","refs/heads/juanHerrera#RefactorCode");
  git("config","push.default","simple");
  return {root,git,close:()=>rmSync(root,{recursive:true,force:true})};
}
test("Git publication requires direct authorization by the user in the current Implementer round",()=>{
  assert.deepEqual(gitRoundAuthorization(authority),{commit:true,push:true});
  assert.deepEqual(gitRoundAuthorization({...authority,instructions:"Listo hagamos commit"}),{commit:true,push:false});
  assert.deepEqual(gitRoundAuthorization({...authority,instructions:"Haz push"}),{commit:false,push:true});
  for(const instructions of ["no hagamos commit y push","Explica cómo hacer commit y push","¿Hagamos commit y push?","Revisa si se puede hacer commit y push","Antes de hacer commit y push, revisa", "hagamos commit y push forzado","hagamos commit y push a la rama main","Ejemplo: hagamos commit y push"]) {
    assert.deepEqual(gitRoundAuthorization({...authority,instructions}),{commit:false,push:false},instructions);
  }
  assert.deepEqual(gitRoundAuthorization({...authority,agentId:"tester"}),{commit:false,push:false});
});
test("Observed staged-file, multiline commit and upstream push forms are authorized individually",()=>{
  const f=fixture();
  try {
    const decide=(resources:string[],command=resources.join("; "),auth=authority,profile:"workspace-write"|"read-only"|"approval-required"="workspace-write",workdir=f.root)=>
      assessOpenCodePermission({action:"shell",resources,save:["git *","cat *"]},f.root,profile,auth,{command,workdir});
    writeFileSync(join(f.root,"src","A.java"),"class A { int x; }\n");
    writeFileSync(join(f.root,"src","B.java"),"class B {}\n");
    const add='git add \\\n  "src/A.java" \\\n  "src/B.java"';
    const staged=[add,'echo "=== STAGED ==="',"git diff --cached --stat",'echo "=== CHECK ==="',"git diff --cached --check",'echo "check-ok"','echo "=== STATUS ==="',"git status --porcelain=v1"];
    const actual=staged.join(" && ");
    assert.equal(decide(staged,actual).verdict,"auto");
    for(const bad of ["git add .","git add -A","git add src","git add ../x","git add src/*.java",'git add "$(whoami)"',"git add --force src/A.java","git add .env","git add src/link.java"]) assert.notEqual(decide([bad]).verdict,"auto",bad);
    symlinkSync("/etc/passwd",join(f.root,"src","link.java"));
    assert.notEqual(decide(["git add src/link.java"]).verdict,"auto");
    assert.notEqual(decide(staged,actual+"; touch /tmp/x").verdict,"auto");
    // Backslash-newline is removal, not an invented argument separator.
    writeFileSync(join(f.root,"src","C.java"),"class C {}");
    assert.notEqual(decide(["git add src/A.java\\\nsrc/C.java"]).verdict,"auto");
    assert.notEqual(assessOpenCodePermission({action:"shell",resources:staged},f.root,"workspace-write",authority,null).verdict,"auto");
    assert.notEqual(decide(staged,actual,authority,"read-only").verdict,"auto");
    assert.notEqual(decide(staged,actual,authority,"approval-required").verdict,"auto");
    assert.notEqual(decide(staged,actual,authority,"workspace-write","/tmp").verdict,"auto");
    assert.notEqual(decide(staged,actual,{...authority,instructions:"Revisa los cambios"}).verdict,"auto");
    f.git("add","src/A.java","src/B.java");
    const body='feat: prueba\n\nTexto literal "" y $(whoami), sin expansión.\nCo-Authored-By: Test <test@example.invalid>';
    const cat="cat <<'EOF'\n"+body+"\nEOF";
    const commit='git commit -m "$('+cat+'\n)"';
    const parts=[commit,cat,"git log --oneline -2",'echo "=== POST-COMMIT STATUS ==="',"git status --porcelain=v1 -b"];
    const cmd=[commit,...parts.slice(2)].join(" && ");
    assert.equal(decide(parts,cmd).verdict,"auto");
    assert.equal(decide(["git commit -m 'fix: literal'"]).verdict,"auto");
    for(const bad of ['git commit --amend -m "x"','git commit -am "x"','git commit -m "$(whoami)"','git commit -m "$(cat /etc/passwd)"','git commit -m "$(cat <<EOF\n$(whoami)\nEOF\n)"',cat])
      assert.notEqual(decide([bad]).verdict,"auto",bad);
    assert.notEqual(decide([commit,cat,"git push"],commit+" && git push").verdict,"auto");
    assert.notEqual(decide(parts,cmd,{...authority,instructions:"Haz push"}).verdict,"auto");
    f.git("commit","-m","local change");
    const push=["git push 2>&1",'echo "exit=$?"','echo "=== FINAL STATUS ==="',"git status --porcelain=v1 -b","git log --oneline -1 origin/juanHerrera#RefactorCode 2>/dev/null",'git log --oneline -1 origin/"juanHerrera#RefactorCode"'];
    const pushCmd=push.slice(0,-1).join("; ")+" || "+push.at(-1);
    assert.equal(decide(push,pushCmd).verdict,"auto");
    assert.notEqual(decide(push,pushCmd,{...authority,instructions:"Haz commit"}).verdict,"auto");
    for(const bad of ["git push --force","git push --all","git push origin other","git push origin :main","git push --mirror"]) assert.notEqual(decide([bad]).verdict,"auto");
    f.git("config","remote.origin.push","refs/heads/*:refs/heads/*");
    assert.notEqual(decide(push,pushCmd).verdict,"auto");
    f.git("config","--unset","remote.origin.push");
    f.git("config","remote.origin.pushurl","https://other.example.invalid/project.git");
    assert.notEqual(decide(push,pushCmd).verdict,"auto");
    f.git("config","--unset","remote.origin.pushurl");
    writeFileSync(join(f.root,".env"),"SECRET=test");
    f.git("add","-f",".env");
    assert.notEqual(decide(["git commit -m 'unsafe'"]).verdict,"auto");
    f.git("commit","-m","unsafe staged");
    assert.notEqual(decide(push,pushCmd).verdict,"auto");
  }finally{f.close();}
});
test("Git remote inspection is safe only when effective URL has no embedded credentials",()=>{
  const f=fixture();
  try {
    const read=(resources:string[])=>assessOpenCodePermission({action:"shell",resources},f.root,"workspace-write",undefined,{command:resources.join("; "),workdir:f.root});
    assert.equal(read(["git rev-parse --abbrev-ref HEAD",'echo "---"',"git status --porcelain=v1 -b","git remote -v","git log --oneline -3"]).verdict,"auto");
    assert.equal(read(["git show --stat --format=fuller HEAD","git rev-parse HEAD origin/juanHerrera#RefactorCode"]).verdict,"auto");
    assert.notEqual(assessOpenCodePermission({action:"shell",resources:["git remote -v"]},f.root,"workspace-write").verdict,"auto");
    assert.notEqual(assessOpenCodePermission({action:"shell",resources:["git remote -v"]},f.root,"workspace-write",undefined,{command:"git remote -v",workdir:"/tmp"}).verdict,"auto");
    f.git("remote","set-url","origin","https://ExampleOrg@dev.azure.com/ExampleOrg/Example%20Project/_git/repo");
    assert.equal(read(["git remote -v"]).verdict,"auto");
    f.git("remote","set-url","origin","https://token@dev.azure.com/ExampleOrg/project/_git/repo");
    assert.notEqual(read(["git remote -v"]).verdict,"auto");
    f.git("remote","set-url","origin","https://ExampleOrg:secret@dev.azure.com/ExampleOrg/project/_git/repo");
    assert.notEqual(read(["git remote -v"]).verdict,"auto");
    f.git("remote","set-url","origin","https://user:password@github.com/example/repo.git");
    assert.notEqual(read(["git remote -v"]).verdict,"auto");
    f.git("remote","set-url","origin","ext::sh -c bad");
    assert.notEqual(read(["git remote -v"]).verdict,"auto");
  }finally{f.close();}
});
test("Native tool source must identify the matching message and call; no omitted command segments",()=>{
  const input={command:"git push",workdir:"/project"};
  const messages={data:[{type:"assistant",id:"m1",content:[{type:"tool",tool:"shell",id:"part1",callID:"call1",state:{input}}]}]};
  assert.deepEqual(findNativeGitToolInput(messages,{source:{type:"tool",messageID:"m1",id:"call1"}}),input);
  assert.equal(findNativeGitToolInput(messages,{source:{type:"tool",messageID:"m2",id:"call1"}}),null);
  assert.equal(findNativeGitToolInput(messages,{source:{type:"tool",messageID:"m1",id:"call2"}}),null);
  assert.equal(nativeGitCommandMatches("git push; git status",["git push","git status"]),true);
  for(const bad of ["git push & git status","git push | git status","git push; other; git status","git push; git status; touch x"]) assert.equal(nativeGitCommandMatches(bad,["git push","git status"]),false);
});

test("Tester observed Git metadata variants pass only with safe effective configuration and native evidence",()=>{
  const f=fixture();
  try {
    // No network operation is executed by the permission evaluator.
    const commands=[
      "git config --get-regexp '^branch\\.'",
      "git config --get push.default",
      "git ls-files .DS_Store",
      "git show --stat --format=fuller HEAD",
      "git rev-parse HEAD origin/juanHerrera#RefactorCode",
      "git ls-remote origin 'refs/heads/juanHerrera#RefactorCode'",
      "git ls-remote --heads origin",
      "git config --get-regexp '^remote\\.origin\\.'",
      "git for-each-ref refs/remotes/origin --format='%(refname) %(objectname:short) %(committerdate:iso)'",
      "git reflog show 'origin/juanHerrera#RefactorCode' --date=iso",
      "git config --show-origin --get-regexp '^url\\.'",
      "git ls-remote origin 'refs/heads/*Herrera*'",
      "git ls-remote --heads origin --verbose",
      "git ls-remote origin refs/heads/main",
      "git fetch --dry-run origin 'refs/heads/juanHerrera#RefactorCode'",
      "git remote get-url --push origin",
      "git ls-remote origin",
      "git show --name-status --format='%H%n%P%n%s' HEAD",
      "git rev-parse --abbrev-ref '@{u}'",
      "type -a git",
      "git --exec-path"
    ];
    const decide=(command:string, profile:"workspace-write"|"read-only"|"approval-required"="workspace-write",input:Record<string,unknown>|null={command,workdir:f.root}) =>
      assessOpenCodePermission({action:"shell",resources:[command],save:["git *"]},f.root,profile,undefined,input);
    for(const command of commands){
      assert.equal(decide(command).verdict,"auto",command);
      assert.notEqual(decide(command,"read-only").verdict,"auto",command);
      assert.notEqual(decide(command,"approval-required").verdict,"auto",command);
    }
    for(const command of ["git config --global --get-regexp '^(http|https|credential|url|push)\\.'","git config --system --list",
      "git config --list","git config --get credential.helper","git config --get http.extraHeader","git config --get-regexp '.*'",
      "git config --get-regexp '^http\\.'","git config push.default matching",
      "git ls-files .env","git ls-files ../other","git ls-files --stage --debug",
      "git ls-remote https://other.invalid/repo","git ls-remote --upload-pack=sh origin",
      "git ls-remote origin 'refs/heads/*;evil*'","git ls-remote origin refs/heads/*",
      "git fetch origin","git fetch --dry-run other refs/heads/main","git fetch --dry-run origin 'refs/heads/main:refs/heads/main'",
      "git fetch --dry-run --prune origin refs/heads/main","git reflog expire --all",
      "git for-each-ref --shell --format='%(refname)'","type -a git; pwd","git --exec-path=/tmp"]) {
      assert.notEqual(decide(command).verdict,"auto",command);
    }
    for(const command of ["git config --get push.default","git ls-remote origin","git remote get-url --push origin"]) {
      assert.notEqual(decide(command,"workspace-write",null).verdict,"auto");
      assert.notEqual(decide(command,"workspace-write",{command,workdir:"/tmp"}).verdict,"auto");
      assert.notEqual(decide(command,"workspace-write",{command:command+"; pwd",workdir:f.root}).verdict,"auto");
      assert.notEqual(decide(command,"workspace-write",{command,workdir:f.root,env:{GIT_CONFIG_COUNT:"1"}}).verdict,"auto");
    }
    f.git("config","branch.juanHerrera#RefactorCode.description","a potentially sensitive description");
    assert.notEqual(decide(commands[0]!).verdict,"auto");
    f.git("config","--unset","branch.juanHerrera#RefactorCode.description");
    f.git("config","remote.origin.pushurl","https://token:secret@github.com/example/repo.git");
    assert.notEqual(decide("git remote get-url --push origin").verdict,"auto");
    assert.notEqual(decide("git config --get-regexp '^remote\\.origin\\.'").verdict,"auto");
    f.git("config","--unset","remote.origin.pushurl");
    f.git("config","remote.origin.uploadpack","unsafe-helper");
    assert.notEqual(decide("git ls-remote origin").verdict,"auto");
    f.git("config","--unset","remote.origin.uploadpack");
    f.git("config","url.https://other.invalid/.insteadOf","https://github.com/");
    assert.notEqual(decide("git config --show-origin --get-regexp '^url\\.'").verdict,"auto");
    assert.notEqual(decide("git ls-remote origin").verdict,"auto");
    f.git("config","--unset","url.https://other.invalid/.insteadOf");
    f.git("config","fetch.recurseSubmodules","true");
    assert.notEqual(decide("git fetch --dry-run origin refs/heads/main").verdict,"auto");
    assert.equal(decide("git ls-remote origin").verdict,"auto");
  }finally{f.close();}
});

test("Claude reviewer and arbiter exact round-four Git and Gradle recipes are recognized",()=>{
  const f=fixture();
  try {
    writeFileSync(join(f.root,"gradlew"),"#!/bin/sh\n",{mode:0o755});
    const cd='cd "'+f.root+'" && ';
    const commands=[
      cd+'git rev-parse --abbrev-ref HEAD && echo "---STATUS---" && git status --porcelain=v1 -b && echo "---LOG---" && git log --oneline -4 && echo "---SHOW---" && git show --name-status --format=\'%H%n%P%n%an <%ae>%n%s\' HEAD && echo "---STAT---" && git show --stat --format=\'\' HEAD',
      cd+'echo "---LS-REMOTE-ALL---" && git ls-remote origin 2>&1; echo "exit=$?"; echo "---FETCH-DRY-RUN-BRANCH---" && git fetch --dry-run origin \'refs/heads/juanHerrera#RefactorCode\' 2>&1; echo "exit=$?"; echo "---REMOTE-URL---" && git remote -v',
      cd+'./gradlew test --rerun-tasks --console=plain 2>&1 | tail -30',
      cd+'echo "---FOR-EACH-REF---" && git for-each-ref refs/remotes/origin --format=\'%(refname) %(objectname:short) %(committerdate:iso)\' && echo "---REFLOG-TAIL---" && git reflog show \'origin/juanHerrera#RefactorCode\' --date=iso 2>&1 | head -3 && echo "---AHEAD/BEHIND---" && git rev-list --left-right --count \'origin/juanHerrera#RefactorCode...HEAD\' 2>&1',
      'git rev-parse --abbrev-ref HEAD; git log --oneline -1; git status --porcelain=v1 -b; echo "--- REMOTE REF ---"; timeout 90 git ls-remote origin \'refs/heads/juanHerrera#RefactorCode\'; echo "exit_ref=$?"; echo "--- REMOTE HEADS ---"; timeout 90 git ls-remote --heads origin; echo "exit_heads=$?"',
      './gradlew test --rerun-tasks --console=plain 2>&1 | tail -12; echo "exit=${PIPESTATUS[0]}"'
    ];
    const decide=(command:string,profile:"workspace-write"|"read-only"|"approval-required"="workspace-write",cwd:string|undefined=f.root)=>
      assessAuditorTool({engine:"claude",toolName:"Bash",input:{command,cwd},projectPath:f.root,permissionProfile:profile});
    for(const command of commands){
      assert.equal(decide(command).verdict,"auto",command);
      assert.notEqual(decide(command,"read-only").verdict,"auto",command);
      assert.notEqual(decide(command,"approval-required").verdict,"auto",command);
      assert.notEqual(decide(command,"workspace-write","/tmp").verdict,"auto",command);
      assert.notEqual(decide(command+"; git push").verdict,"auto",command);
    }
    assert.match(decide(commands[2]!).reason,/no acredita éxito/);
    assert.equal(decide(commands[5]!).category,"test");
    for(const command of [
      'git status; git config --global --list',
      'git status; git remote get-url --push origin; cat /etc/passwd',
      'git status && timeout 121 git ls-remote origin',
      'timeout 90 git fetch origin',
      'git ls-remote origin | head -3 /etc/passwd',
      'git rev-list --left-right --count \'origin/main...HEAD\' > /tmp/a',
      'git show --name-status --format=\'%H%n%P%n%s\' HEAD; echo "$(whoami)"',
      'git show --stat --format=\'\' HEAD; echo "---AHEAD/BEHIND---"; git clean -fd',
      './gradlew test 2>&1 | tail -101',
      './gradlew test 2>&1 | tail -30; echo "exit=$HOME"',
      './gradlew test 2>&1 | tail -30 /etc/passwd'
    ])assert.notEqual(decide(command).verdict,"auto",command);
    assert.notEqual(assessAuditorTool({engine:"claude",toolName:"Bash",input:{command:commands[4]},projectPath:f.root,permissionProfile:"workspace-write"}).verdict,"auto");
    f.git("config","remote.origin.url","https://token:secret@github.com/example/repo.git");
    assert.notEqual(decide(commands[1]!).verdict,"auto");
    assert.notEqual(decide(commands[4]!).verdict,"auto");
  }finally{f.close();}
});

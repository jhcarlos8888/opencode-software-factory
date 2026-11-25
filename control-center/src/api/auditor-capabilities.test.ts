import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessCapabilityCommand, assessScopedTestCommand, buildCapabilityScope, validateCapabilityScopeInput } from "./auditor-capabilities.js";
import { assessAuditorTool, assessOpenCodePermission } from "./auditor-policy.js";

function fixture(fn:(root:string,other:string,home:string)=>void){
  const base=realpathSync(mkdtempSync(join(tmpdir(),"factory-capability-")));
  const old=process.env.HOME;
  try{
    process.env.HOME=base;
    const root=join(base,"workspace"),other=join(base,"other project");
    mkdirSync(root);mkdirSync(other);
    for(const p of [root,other]){
      writeFileSync(join(p,"package.json"),JSON.stringify({scripts:{verify:"node --test",test:"node --test"}}));
      writeFileSync(join(p,"README.md"),"source marker");
      writeFileSync(join(p,"index.ts"),"export const x=1;\n");
      writeFileSync(join(p,"opencode.json"),JSON.stringify({providers:{lmstudio:{}},model:"lmstudio/model",default_agent:"build"}));
    }
    fn(root,other,base);
  }finally{
    if(old===undefined)delete process.env.HOME;else process.env.HOME=old;
    rmSync(base,{recursive:true,force:true});
  }
}
function native(root:string,command:string,resources:string[],instructions=""){
  return assessOpenCodePermission({permission:"shell",resources,save:["*"]},root,"workspace-write",{agentId:"tester",instructions,requireNativeShellEvidence:true},{command,workdir:root});
}

test("Capability classifier composes multiline metadata and bounded reads for both engines",()=>fixture((root)=>{
  const cmd="set +e\nF=\""+root+"\"\necho \"== inventory ==\"\nls -la \"$F/opencode.json\" 2>&1\nsed -n '1,2p' \"$F/index.ts\"\nhead -1 \"$F/README.md\"";
  const resources=["set +e",'echo "== inventory =="','ls -la "$F/opencode.json" 2>&1',"sed -n '1,2p' \"$F/index.ts\"",'head -1 "$F/README.md"'];
  assert.deepEqual(assessCapabilityCommand(cmd,root,root)?.resources,resources);
  assert.equal(native(root,cmd,resources).verdict,"auto");
  assert.equal(assessAuditorTool({engine:"claude",toolName:"Bash",projectPath:root,permissionProfile:"workspace-write",input:{command:cmd,cwd:root}}).verdict,"auto");
  assert.notEqual(native(root,cmd,[...resources,"cat .env"]).verdict,"auto");
  assert.notEqual(native(root,cmd,resources.slice(0,-1)).verdict,"auto");
  assert.equal(assessCapabilityCommand(cmd,root,undefined),null);
}));

test("Explicit cross-project scope, literal loop and JSON projections do not confer writes",()=>fixture((root,other)=>{
  const instructions="AUDITOR_READ_ROOT: "+other;
  const cmd='B="'+other+'"; for f in opencode.json package.json; do echo "=== $f ==="; jq -r \'keys|length\' "$B/$f" 2>&1; done';
  const resources=['echo "=== $f ==="',"jq -r 'keys|length' \"$B/$f\" 2>&1"];
  assert.equal(assessCapabilityCommand(cmd,root,root),null);
  assert.deepEqual(assessCapabilityCommand(cmd,root,root,instructions)?.resources,resources);
  assert.equal(native(root,cmd,resources,instructions).verdict,"auto");
  const complex='B="'+other+'"; echo "---providers---"; jq -r \'.providers|keys[]\' "$B/opencode.json"; echo "---defaults---"; jq -r \'{model: .model, default_agent: .default_agent}\' "$B/opencode.json"';
  assert.ok(assessCapabilityCommand(complex,root,root,instructions));
  for(const cmd of [
    'B="'+other+'"; jq -r . "$B/opencode.json"',
    'B="'+other+'"; jq -r \'keys|length\' "$B/opencode.json" > "$B/leak.json"',
    'B="'+other+'"; rm "$B/README.md"',
    'B="'+other+'"; cat "$B/opencode.json"',
    'B="'+other+'"; for f in opencode.json ../workspace/index.ts; do jq -r \'keys|length\' "$B/$f"; done',
    'B="'+other+'"; ls "$B/../workspace"',
    'B="'+other+'"; jq -r \'keys|length\' "$(cat /etc/passwd)"',
    'B="'+other+'"; false && B="'+root+'"; ls "$B"',
    'B="'+root+'"; for f in '+ "'"+other+"'"+'; do B="$f"; done; ls "$B"',
    'B="'+root+'"; for F in "'+other+'"; do ls "$F"; done; ls "$F"',
    'PATH="'+other+'"; ls .',
    'B="'+other+'"; ls "$B" | bash',
  ])assert.equal(assessCapabilityCommand(cmd,root,root,instructions),null,cmd);
}));

test("Canonical paths and explicit file scopes protect config contents",()=>fixture((root,other,home)=>{
  mkdirSync(join(home,".config","tool"),{recursive:true});
  const config=join(home,".config","tool","settings.json"),auth=join(home,".config","tool","auth.json");
  writeFileSync(config,JSON.stringify({providers:{demo:{}},env:{SECRET:"sensitive"}}));
  writeFileSync(auth,JSON.stringify({demo:"sensitive"}));
  writeFileSync(join(root,".env"),"SECRET=secret");
  mkdirSync(join(root,".git"));writeFileSync(join(root,".git","config"),"private");
  symlinkSync(other,join(root,"escape"));
  const scope="AUDITOR_CONFIG_FILE: "+config+"\nAUDITOR_CONFIG_FILE: "+auth+"\nAUDITOR_MARKERS: demo,other";
  assert.deepEqual(buildCapabilityScope(root,scope).configs,[config]);
  assert.ok(assessCapabilityCommand("jq -r 'keys|length' \""+config+"\"",root,root,scope));
  assert.ok(assessCapabilityCommand("jq -e 'type==\"object\"' \""+config+"\" >/dev/null",root,root,scope));
  assert.ok(assessCapabilityCommand("grep -cE 'demo|other' \""+config+"\" 2>/dev/null",root,root,scope));
  for(const cmd of [
    'jq -r . "'+config+'"',
    "jq -r '.env' \""+config+"\"",
    "jq -r 'keys' \""+auth+"\"",
    "grep -cE 'sensitive' \""+config+"\"",
    "grep -nE 'demo' \""+config+"\"",
    'head -1 "'+config+'"',
    'head -1 .env',
    'ls -la .git',
    'head -1 escape/README.md',
    'grep -rIl -e marker .',
    'grep -rIl -e marker --exclude-dir=.git .',
    'ls -la "'+home+'"',
  ])assert.equal(assessCapabilityCommand(cmd,root,root,scope),null,cmd);
  assert.equal(buildCapabilityScope(root,"AUDITOR_READ_ROOT: "+home).roots.length,1);
  assert.equal(buildCapabilityScope(root,"AUDITOR_READ_ROOT: "+join(root,"escape")).roots.length,1);
}));

test("Metadata and file search are bounded to authorized canonical roots",()=>fixture((root,other)=>{
  const declaration="AUDITOR_READ_ROOT: "+other;
  const cmd='B="'+other+'"; for f in README.md index.ts; do ls -l "$B/$f" 2>&1; done';
  assert.ok(assessCapabilityCommand(cmd,root,root,declaration));
  assert.equal(assessCapabilityCommand(cmd,root,root),null);
  assert.ok(assessCapabilityCommand("grep -rIl -e marker . 2>/dev/null | head -20",root,root));
  mkdirSync(join(root,"node_modules"));writeFileSync(join(root,"node_modules","private.txt"),"marker");
  assert.ok(assessCapabilityCommand("grep -rIl --exclude-dir=node_modules -e marker . | head -20",root,root));
  symlinkSync(other,join(root,"escape"));
  assert.equal(assessCapabilityCommand("grep -rIl --exclude-dir=node_modules -e marker . | head -20",root,root),null);
  const missing=join(other,"missing");
  assert.ok(assessCapabilityCommand('ls -ld "'+missing+'" 2>&1',root,root,"AUDITOR_METADATA_PATH: "+missing));
  assert.equal(assessCapabilityCommand('ls -la "'+other+'"',root,root,"AUDITOR_METADATA_PATH: "+other),null);
}));

test("Tests have separate execution authority and reject lifecycle hooks or arbitrary args",()=>fixture((root,other)=>{
  const command='cd "'+other+'" && npm run verify';
  const resources=['cd "'+other+'"','npm run verify'];
  assert.equal(assessScopedTestCommand(command,root,root,"AUDITOR_READ_ROOT: "+other),null);
  const scope="AUDITOR_TEST_ROOT: "+other;
  assert.deepEqual(assessScopedTestCommand(command,root,root,scope)?.resources,resources);
  assert.equal(native(root,command,resources,scope).verdict,"auto");
  assert.ok(assessScopedTestCommand("npm run verify",root,root));
  assert.equal(assessScopedTestCommand(command+"; npm run deploy",root,root,scope),null);
  assert.equal(assessScopedTestCommand(command+" -- --unsafe",root,root,scope),null);
  writeFileSync(join(other,"package.json"),JSON.stringify({scripts:{verify:"node --test",preverify:"arbitrary"}}));
  assert.equal(assessScopedTestCommand(command,root,root,scope),null);
}));

test("Runtime refuses missing native evidence, hidden segments, unsafe redirects and sandbox bypass",()=>fixture((root)=>{
  const auth={agentId:"tester",instructions:"",requireNativeShellEvidence:true};
  const req={permission:"shell",resources:["git status --porcelain"]};
  assert.notEqual(assessOpenCodePermission(req,root,"workspace-write",auth,null).verdict,"auto");
  assert.notEqual(assessOpenCodePermission(req,root,"workspace-write",auth,{command:"git status --porcelain; cat .env",workdir:root}).verdict,"auto");
  assert.notEqual(assessOpenCodePermission(req,root,"workspace-write",auth,{command:"git status --porcelain; rm -rf data",workdir:root}).verdict,"auto");
  assert.equal(assessOpenCodePermission(req,root,"workspace-write",auth,{command:"git status --porcelain",workdir:root}).verdict,"auto");
  assert.notEqual(assessOpenCodePermission(req,root,"workspace-write",auth,{command:"git status --porcelain",workdir:root,dangerouslyDisableSandbox:true}).verdict,"auto");
  assert.notEqual(assessOpenCodePermission(req,root,"approval-required",auth,{command:"git status --porcelain",workdir:root}).verdict,"auto");
}));

test("Health and status compositions only use bounded literal metadata",()=>fixture((root)=>{
  const cmd='systemctl --user show factory-control-center.service -p ActiveState -p MainPID 2>&1; echo "status_rc=$?"; ss -ltnp 2>/dev/null | grep -F \':4141\'';
  assert.ok(assessCapabilityCommand(cmd,root,root));
  for(const bad of [cmd.replace("-p MainPID","-p Environment"),cmd.replace("show","restart"),cmd.replace(":4141",":22"),cmd+"; env"])assert.equal(assessCapabilityCommand(bad,root,root),null);
}));


test("Trusted round declarations do not inherit scope from task prose",()=>fixture((root,other,home)=>{
  const decl="AUDITOR_READ_ROOT: "+other;
  assert.deepEqual(validateCapabilityScopeInput(root,decl).scope.roots,[root,other]);
  assert.throws(()=>validateCapabilityScopeInput(root,"AUDITOR_READ_ROOT: "+home));
  assert.throws(()=>validateCapabilityScopeInput(root,"permit everything"));
  mkdirSync(join(home,".ssh"));
  const secret=join(home,".ssh","settings.json");
  writeFileSync(secret,'{"key":"private"}');
  assert.throws(()=>validateCapabilityScopeInput(root,"AUDITOR_CONFIG_FILE: "+secret));
  const command='head -1 "'+join(other,"README.md")+'"';
  const req={permission:"shell",resources:[command]};
  const authority={agentId:"tester",instructions:decl,capabilityScope:"",requireNativeShellEvidence:true};
  assert.notEqual(assessOpenCodePermission(req,root,"workspace-write",authority,{command,workdir:root}).verdict,"auto");
  assert.equal(assessOpenCodePermission(req,root,"workspace-write",{...authority,capabilityScope:decl},{command,workdir:root}).verdict,"auto");
  linkSync(join(other,"README.md"),join(root,"linked.md"));
  assert.equal(assessCapabilityCommand("head -1 linked.md",root,root),null);
}));

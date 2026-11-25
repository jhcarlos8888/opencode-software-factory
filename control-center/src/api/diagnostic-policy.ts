import { lstatSync, realpathSync, readFileSync, accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { isSensitiveFilesystemPath } from "./filesystem-guards.js";

export function isDiagnosticCandidate(command: string): boolean {
  if (command === "command -v bun" || command === resolve(homedir(),".bun/bin/bun")+" --version 2>/dev/null") return true;
  if (command === resolve(homedir(),".opencode/bin/opencode") + " --version 2>&1" || command === resolve(homedir(),".opencode/bin/opencode") + " --version") return true;
  return /(?:^|; | && )(?:(?:node|npm|bun|git) (?:--version|-v)|ls (?:-l(?:a)?(?: |$)|-d node_modules|\.github\/workflows)|for f in |ss -ltnp|curl (?:-fsSL --max-time |-sS -m |-sS --max-time |-fsS --max-time |-s --max-time )|date -u |systemctl --user (?:list-units|show|is-active|is-enabled)|~\/\.bun\/bin\/bun --version|sha256sum |npm (?:test|pack --dry-run)(?: |$)|git ls-remote https:\/\/github\.com\/)/.test(command);
}
function canonicalRoot(root: string): boolean {
  try { return isAbsolute(root) && realpathSync(root) === root && lstatSync(root).isDirectory(); }
  catch { return false; }
}
function safeSource(root: string, name: string): boolean {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/.test(name) ||
      name.split("/").some(p=>p===".."||p==="." ) || isSensitiveFilesystemPath(name) ||
      !/^(?:package\.json|models\.json|agent-tools\.json|agent-preamble\.txt|README\.md|LICENSE|zen-proxy|[A-Za-z0-9_./-]+\.(?:mjs|cjs|js|ts|java|sh|md))$/.test(name)) return false;
  try { const file=resolve(root,name); const stat=lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink() && realpathSync(file)===file && stat.size<=32*1024*1024;
  } catch { return false; }
}
function trustedNodeTest(root: string): boolean {
  try {
    const file=resolve(root,"package.json");
    if (!safeSource(root,"package.json") || lstatSync(file).size>256*1024) return false;
    const scripts=JSON.parse(readFileSync(file,"utf8")).scripts;
    return scripts?.test==="node --test" && scripts.pretest===undefined && scripts.posttest===undefined;
  }catch{return false;}
}
function safeDryPack(root:string):boolean{
  try{
    const file=resolve(root,"package.json");
    if(!safeSource(root,"package.json") || lstatSync(file).size>256*1024)return false;
    const pkg=JSON.parse(readFileSync(file,"utf8"));
    return !pkg.workspaces && ["prepack","prepare","postpack","prepublish","prepublishOnly"].every(name=>pkg.scripts?.[name]===undefined);
  }catch{return false;}
}
function requestedPublicRepo(command: string, instructions: string, root: string): boolean {
  const m=/^git ls-remote (https:\/\/github\.com\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+) refs\/heads\/(?:main|master)$/.exec(command);
  if(!m)return false;
  const repo=m[1]!.replace(/\.git$/,"");
  const urls=instructions.match(/https:\/\/github\.com\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+/g)??[];
  if(!urls.some(url=>url.replace(/\.git$/,"")===repo))return false;
  // Do not allow a configured URL rewrite to silently redirect the request.
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith("GIT_")));
  const result=spawnSync("git",["-C",root,"config","--get-regexp","^url\\."],{
    env,encoding:"utf8",timeout:1500,maxBuffer:65536,stdio:["ignore","pipe","pipe"]
  });
  return !result.error && result.status===1 && result.stdout==="" && result.stderr==="";
}
function repoMentioned(instructions:string,repo:string):boolean{
  return (instructions.match(/https:\/\/github\.com\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+/g)??[])
    .some(url=>url.replace(/\.git$/,"")==="https://github.com/"+repo);
}
function curlDefaultsAbsent():boolean{
  const locations=[resolve(homedir(),".curlrc"),resolve(homedir(),".config/curlrc")];
  if(process.env.CURL_HOME)locations.push(resolve(process.env.CURL_HOME,".curlrc"));
  if(process.env.XDG_CONFIG_HOME)locations.push(resolve(process.env.XDG_CONFIG_HOME,"curlrc"));
  return locations.every(file=>{try{lstatSync(file);return false;}catch(e){return (e as NodeJS.ErrnoException).code==="ENOENT";}});
}
function publicMetadata(part:string,instructions:string):string[]|null{
  // Public issue index only: exact projection and bounded page/line limits.
  const issues=/^(curl -fsSL (?:--max-time|-m) (?:[1-9]|[1-5]\d|60) 'https:\/\/api\.github\.com\/repos\/([A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+)\/issues\?state=all&per_page=(?:[1-9]|[1-4]\d|50)&sort=updated' 2>&1) \| (jq -c '\.\[\] \| \{n:\.number, state:\.state, title:\.title, comments:\.comments, created:\.created_at, pr:\(\.pull_request!=null\)\}' 2>&1) \| (head -(?:[1-9]\d?|100))$/.exec(part);
  if(issues && repoMentioned(instructions,issues[2]!) && curlDefaultsAbsent()){
    return [issues[1]!,issues[3]!,issues[4]!];
  }
  const m=/^(curl -fsSL (?:--max-time|-m) (?:[1-9]|[1-5]\d|60) (?:'([^']+)'|([^\s'"]+))(?: 2>\/dev\/null)?)(?: \| (head -c (?:[1-9]\d{0,3}|10000)))?$/.exec(part);
  if(!m || !curlDefaultsAbsent())return null;
  const url=m[2]??m[3]??"";
  const raw=/^https:\/\/raw\.githubusercontent\.com\/([A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+)\/(?:main|master)\/(?:package\.json|models\.json|README\.md)$/.exec(url);
  const api=/^https:\/\/api\.github\.com\/repos\/([A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+)\/(?:commits|issues)\?per_page=(?:[1-9]|[1-4]\d|50)$/.exec(url);
  const registry=/^https:\/\/registry\.npmjs\.org\/(?:[a-z0-9_-]+|@[a-z0-9_-]+%2[fF][a-z0-9_-]+)\/latest$/.test(url);
  // npm public metadata only, never credentials, query payloads or private registries.
  if(!(raw&&repoMentioned(instructions,raw[1]!) || api&&repoMentioned(instructions,api[1]!) || registry))return null;
  if((api||registry)&&!m[4])return null;
  return m[4]?[m[1]!,m[4]]:[m[1]!];
}
// These recipes do not use relative filesystem paths or shell variables.
// Missing cwd is acceptable only for this separately closed grammar.
function localProxyPort(root:string):number|null{
  if(basename(root).replace(/^\./,"")!=="zen-proxy")return null;
  try{
    const manifest=resolve(root,"package.json"),config=resolve(root,"zen-proxy.json");
    for(const file of [manifest,config]){
      const info=lstatSync(file);
      if(!info.isFile()||info.isSymbolicLink()||realpathSync(file)!==file||info.size>65536)return null;
    }
    if(JSON.parse(readFileSync(manifest,"utf8")).name!=="zen-proxy")return null;
    const cfg=JSON.parse(readFileSync(config,"utf8"));
    if(cfg.host!=="127.0.0.1"||!Number.isInteger(cfg.port)||cfg.port<1||cfg.port>65535||
      cfg.defaultZenKey||cfg.proxyKey||cfg.upstream!=="https://opencode.ai/inference/openai/v1")return null;
    return cfg.port;
  }catch{return null;}
}
function installedTool(path:string):boolean{
  try{
    if(!/^[A-Za-z0-9_./-]+$/.test(path)||realpathSync(path)!==path||!lstatSync(path).isFile())return false;
    accessSync(path,constants.X_OK);
    return true;
  }catch{return false;}
}
export function assessIndependentDiagnostic(command:string,root:string):Recipe|null{
  if(!canonicalRoot(root)||command.length>1800||/[\r\n\x00-\x1f\x60\\]/.test(command))return null;
  const unit=basename(root).replace(/^\./,"")+".service";
  const resources:string[]=[];
  const parts=command.split(/; | && /);
  if(parts.length>12)return null;
  for(const part of parts){
    const plain=part.replace(/ 2>&1$/,"");
    if(/^(?:(?:node|npm|bun) (?:--version|-v)|git --version)$/.test(plain) ||
      plain==="date -u +%Y-%m-%dT%H:%M:%SZ" ||
      part==="echo" ||
      /^echo (?:'---[A-Za-z0-9 _()/\-]{0,40}---'|"---[A-Za-z0-9 _()/\-]{0,40}---")$/.test(part)){
      resources.push(part);continue;
    }
    const bun=resolve(homedir(),".bun/bin/bun");
    if(part==="command -v bun" || part==='command -v bun || echo "bun-no-en-PATH"'){
      resources.push(...part.split(" || "));continue;
    }
    if(installedTool(bun) && [bun+" --version",bun+" --version 2>/dev/null",bun+' --version 2>/dev/null || echo "bun-no-encontrado"'].includes(part)){
      resources.push(...part.split(" || "));continue;
    }
    const cli=resolve(homedir(),".opencode/bin/opencode");
    if(/^[A-Za-z0-9_./-]+$/.test(cli) &&
      (part===cli+" --version" || part===cli+" --version 2>&1" || part===cli+" --version 2>&1 | head -5")){
      try {
        if(!installedTool(cli))return null;
        resources.push(...part.split(" | "));continue;
      }catch{return null;}
    }
    const service=/^systemctl --user (?:is-active|is-enabled) ([A-Za-z0-9_-]+(?:\.service)?)$/.exec(plain);
    const metadata=/^systemctl --user show ([A-Za-z0-9_-]+(?:\.service)?)((?: -p (?:ActiveState|SubState|MainPID|LoadState|UnitFileState|ExecMainStartTimestamp|FragmentPath|NRestarts)){1,8})$/.exec(plain);
    if([service?.[1],metadata?.[1]].some(name=>name===unit||name+".service"===unit)){resources.push(part);continue;}
    const socket=/^(ss -ltnp 2>\/dev\/null) \| (grep ([0-9]{1,5}))$/.exec(part);
    if(socket && Number(socket[3])>0 && Number(socket[3])<=65535 && localProxyPort(root)===Number(socket[3])){
      resources.push(socket[1]!,socket[2]!);continue;
    }
    // Fixed jq projections: no arbitrary expressions or credential fields.
    const projected=/^(curl (?:-s --max-time|-sS -m) (?:[1-9]|10) http:\/\/127\.0\.0\.1:([0-9]{1,5})\/(health|v1\/models|api\/status)) \| (jq -c '([^']+)')$/.exec(part);
    if(projected && curlDefaultsAbsent() && localProxyPort(root)===Number(projected[2])){
      const filters: Record<string,string[]> = {
        health: ["{ok,upstream,sync:.sync.ok,version}"],
        "v1/models": ["{count:(.data|length),ids:(.data|map(.id))}","{count:(.data|length)}"],
        "api/status": ["{uptime,sync:{ok:.sync.ok,at:.sync.at,ms:.sync.ms,running:.sync.running}}","{upstreamOk,requests:.requests.total,sync:{ok:.sync.ok,working:(.sync.working|length),rateLimited:(.sync.rateLimited|length)}}","{upstreamOk,sync:{ok:.sync.ok,working:(.sync.working|length),rateLimited:(.sync.rateLimited|length)},requestsTotal:.requests.total}","{upstreamOk,sync:{ok:.sync.ok,working:(.sync.working|length),rateLimited:(.sync.rateLimited|length),gated:(.sync.gated|length),dead:(.sync.dead|length),flaky:(.sync.flaky|length)},requestsTotal:.requests.total,followsCatalog:.models.followsCatalog,served:(.models.served|length)}","{sync:{ok:.sync.ok,at:.sync.at,ms:.sync.ms,gated:(.sync.gated|length),dead:(.sync.dead|length),flaky:(.sync.flaky|length)}}","{sync:{ok:.sync.ok,at:.sync.at,ms:.sync.ms,errorPresent:(.sync.error|length>0),gated:(.sync.gated|length),dead:(.sync.dead|length),flaky:(.sync.flaky|length)}}"]
      };
      if(filters[projected[3]!]?.includes(projected[5]!.replace(/, +/g,","))){
        resources.push(projected[1]!,projected[4]!);continue;
      }
    }
    // Administrative logs are never printed. Only count the bounded slice.
    const logs=/^(curl -s --max-time (?:[1-9]|10) "http:\/\/127\.0\.0\.1:([0-9]{1,5})\/api\/logs\?n=(?:[1-9]|[1-4]\d|50)") \| (jq -c '\{count:\(\.logs\|length\)\}')$/.exec(part);
    if(logs && curlDefaultsAbsent() && localProxyPort(root)===Number(logs[2])){
      resources.push(logs[1]!,logs[3]!);continue;
    }
    const curl=/^(curl (?:-sS -m|-fsS --max-time) (?:[1-9]|10) http:\/\/127\.0\.0\.1:([0-9]{1,5})\/(?:health|v1\/models)(?: 2>&1)?)(?: \| (head -c (?:[1-9]\d{0,3}|10000)))?$/.exec(part);
    if(curl && curlDefaultsAbsent() && localProxyPort(root)===Number(curl[2])){
      resources.push(curl[1]!);if(curl[3])resources.push(curl[3]);continue;
    }
    return null;
  }
  return resources.length?{category:"inspection",resources}:null;
}
type Recipe = { category:"inspection"|"test"; resources:string[] };
/** Classify the exact complete native command, not a set of independent
 * wildcard grants. Only explicit bounded recipes, no arbitrary shell. */
export function assessDiagnosticCommand(command:string,root:string,cwd:string|undefined,instructions=""):Recipe|null {
  if(!canonicalRoot(root) || command.length>2400 ||
    /[\r\n\x00-\x1f\x60]/.test(command))return null;
  const explicitCd=command.startsWith('cd "'+root+'" && ') ? 'cd "'+root+'" && ' :
    /^[A-Za-z0-9_./-]+$/.test(root) && command.startsWith("cd "+root+" && ") ? "cd "+root+" && " : "";
  if(explicitCd && /["'$&;|<>\\]/.test(root))return null;
  if(explicitCd)command=command.slice(explicitCd.length);
  // The only supported substitution is this fixed public hash recipe.
  // A relative file read after a failed cd is forbidden: with no native
  // cwd require && after the loop and every subsequent command.
  const hashLoop=/^for f in ([A-Za-z0-9_./ -]+); do (printf '%s  %s\\n' "\$\((curl -fsSL -(?:m|\-max-time) (?:[1-9]|[1-5]\d|60) https:\/\/raw\.githubusercontent\.com\/([A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+)\/(?:main|master)\/\$f) \| sha256sum \| (cut -d' ' -f1)\)" "remote\/\$f"); done( && |; )(echo (?:"---LOCAL---"|'---LOCAL---'))( && |; )sha256sum ([A-Za-z0-9_./ -]+)(?:( && |; )(echo (?:"---REMOTE-HEAD---"|'---REMOTE-HEAD---'))( && |; )(git ls-remote https:\/\/github\.com\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+ refs\/heads\/(?:main|master)))?$/.exec(command);
  if(hashLoop){
    const files=hashLoop[1]!.split(" ");
    const hasHead=hashLoop[13]!==undefined;
    if((cwd!==root && (!explicitCd || hashLoop[6]!==" && " || hashLoop[8]!==" && " ||
      (hasHead && (hashLoop[10]!==" && " || hashLoop[12]!==" && ")))) ||
      files.length>20 || !files.every(f=>safeSource(root,f)) ||
      hashLoop[9]!==hashLoop[1] || !repoMentioned(instructions,hashLoop[4]!) || !curlDefaultsAbsent() ||
      (hasHead && (!requestedPublicRepo(hashLoop[13]!,instructions,root) ||
        !hashLoop[13]!.startsWith("git ls-remote https://github.com/"+hashLoop[4]+" "))))return null;
    return {category:"inspection",resources:[hashLoop[2]!,hashLoop[3]!,"sha256sum",hashLoop[5]!,hashLoop[7]!,"sha256sum "+hashLoop[9],...(hasHead?[hashLoop[11]!,hashLoop[13]!]:[])]};
  }
  const catalogHash=/^(sha256sum models\.json) && (printf '%s  %s\\n' "\$\((curl -fsSL -(?:m|\-max-time) (?:[1-9]|[1-5]\d|60) https:\/\/raw\.githubusercontent\.com\/([A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+)\/(?:main|master)\/models\.json) \| sha256sum \| (cut -d' ' -f1)\)" "remote\/models\.json") && (node -e 'const c=require\("\.\/models\.json"\); console\.log\("models:",c\.models\.length,"unique:",new Set\(c\.models\)\.size,"updatedAt:",c\.updatedAt\)')$/.exec(command);
  if(catalogHash){
    if((cwd!==root && !explicitCd)||!safeSource(root,"models.json")||!repoMentioned(instructions,catalogHash[4]!)||!curlDefaultsAbsent())return null;
    try{
      const cfg=JSON.parse(readFileSync(resolve(root,"models.json"),"utf8"));
      if(!Array.isArray(cfg.models)||cfg.models.length>500||!cfg.models.every((m:unknown)=>typeof m==="string"&&/^[A-Za-z0-9_.-]{1,120}$/.test(m))||
        typeof cfg.updatedAt!=="string"||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(cfg.updatedAt))return null;
    }catch{return null;}
    return {category:"inspection",resources:[catalogHash[1]!,catalogHash[2]!,catalogHash[3]!,"sha256sum",catalogHash[5]!,catalogHash[6]!]};
  }
  if((cwd===root || explicitCd) && /^npm test(?: -- --test-reporter=spec)?(?: 2>&1)?; echo "EXIT_CODE=\$\?"$/.test(command) && trustedNodeTest(root)){
    return {category:"test",resources:command.split("; ")};
  }
  // Public issue text is untrusted research data, not executable shell.
  // Match the finite literal loop in full, including both output projections.
  const issueLoop=/^for n in ((?:[1-9]\d{0,7} ){0,2}[1-9]\d{0,7}); do (echo "=== ISSUE \$n BODY ==="); (curl -fsSL -m 20 "https:\/\/api\.github\.com\/repos\/([A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+)\/issues\/\$n") \| (jq -r '\.title, "---", \(\.body \/\/ "" \| \.\[0:900\]\), "---state:" \+ \.state'); (echo "=== COMMENTS \$n ==="); (curl -fsSL -m 20 "https:\/\/api\.github\.com\/repos\/([A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+)\/issues\/\$n\/comments") \| (jq -r '\.\[\] \| "\[" \+ \.user\.login \+ "\]", \(\.body \| \.\[0:700\]\), "-----"'); done$/.exec(command);
  if(issueLoop){
    if(issueLoop[4]!==issueLoop[8] || !repoMentioned(instructions,issueLoop[4]!) || !curlDefaultsAbsent())return null;
    return {category:"inspection",resources:[issueLoop[2]!,issueLoop[3]!,issueLoop[5]!,issueLoop[6]!,issueLoop[7]!,issueLoop[9]!]};
  }
  if(/\\/.test(command))return null;
  if(cwd!==root && (!explicitCd || /;/.test(command)))return null;
  const test=/^npm test(?: -- --test-reporter=spec)?(?: 2>&1(?: \| tail -(?:[1-9]\d?|100); echo "(?:EXIT_CODE|TEST_EXIT)=\$\{PIPESTATUS\[0\]\}")?)?$/.exec(command);
  if(test && trustedNodeTest(root)){
    const parts=command.split(/ \| |; /);
    return {category:"test",resources:parts};
  }
  if(/^npm pack --dry-run --json(?: 2>&1(?: \| head -c (?:[1-9]\d{0,3}|10000)(?:; echo(?:; echo "EXIT_CODE=\$\{PIPESTATUS\[0\]\}")?)?)?)?$/.test(command) && safeDryPack(root)){
    return {category:"inspection",resources:command.split(/ \| |; /)};
  }
  let remainder=command;
  const resources:string[]=[];
  const buildInventory=/^(?:(.*); )?echo "--- artefactos build ---"; for f in ([A-Za-z0-9_. -]+); do if \[ -e "\$f" \]; then echo "PRESENTE: \$f"; else echo "AUSENTE: \$f"; fi; done$/.exec(command);
  if(buildInventory){
    const names=buildInventory[2]!.split(" ");
    const allowed=new Set(["gradlew","build.gradle","build.gradle.kts","settings.gradle","settings.gradle.kts","pom.xml","package.json","package-lock.json","npm-shrinkwrap.json","yarn.lock","pnpm-lock.yaml","bun.lock","bun.lockb","node_modules",".nvmrc",".node-version","Dockerfile","docker-compose.yml","Makefile","Cargo.toml","go.mod","pyproject.toml","requirements.txt"]);
    if(names.length>24||!names.every(f=>allowed.has(f))||cwd!==root)return null;
    const prefix=buildInventory[1];
    const prior=prefix?assessDiagnosticCommand(prefix,root,cwd,instructions):null;
    if(prefix&&(!prior||prior.category!=="inspection"))return null;
    return {category:"inspection",resources:[...(prior?.resources??[]),'echo "--- artefactos build ---"','echo "PRESENTE: $f"','echo "AUSENTE: $f"']};
  }

  // The finite manifest-presence loop reports names only. No shell expansion
  // other than the fixed variable over a bounded literal list.
  const presence=/^echo '--- build files present\? ---'; for f in ([A-Za-z0-9_. -]+); do \[ -e "\$f" \] && echo "FOUND \$f" \|\| echo "MISSING \$f"; done(?:; |$)/.exec(remainder);
  if(presence){
    const allowed=new Set(["gradlew","build.gradle","build.gradle.kts","settings.gradle","settings.gradle.kts","pom.xml","package.json","package-lock.json","npm-shrinkwrap.json","yarn.lock","pnpm-lock.yaml","bun.lockb","bun.lock","Cargo.toml","go.mod","pyproject.toml","requirements.txt"]);
    const files=presence[1]!.split(" ");
    if(files.length>24||!files.every(f=>allowed.has(f)))return null;
    resources.push("echo '--- build files present? ---'",'echo "FOUND $f"','echo "MISSING $f"');
    remainder=remainder.slice(presence[0].length);
  }
  const loop=/^for f in ([A-Za-z0-9_. -]+); do (printf '%s  ' "\$f"); (curl -fsSL --max-time (?:[1-9]|[1-5]\d|60) "https:\/\/raw\.githubusercontent\.com\/([A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+)\/(?:main|master)\/\$f") \| sha256sum; done(?:; |$)/.exec(remainder);
  if(loop){
    const files=loop[1]!.split(" ");
    if(files.length>20 || !files.every(f=>safeSource(root,f)) || !repoMentioned(instructions,loop[4]!) || !curlDefaultsAbsent())return null;
    resources.push(loop[2]!,loop[3]!,"sha256sum");
    remainder=remainder.slice(loop[0].length);
  }
  const parts=remainder?remainder.split(/; | && (?!bun -v 2>&1 \|\| echo "bun: NO ENCONTRADO"(?:; |$))/):[];
  if(parts.length>12)return null;
  for(const part of parts){
    const plain=part.replace(/ 2>&1$/,"");
    if(/^(?:(?:node|npm|bun) (?:--version|-v)|git --version)$/.test(plain)){
      resources.push(part);continue;
    }
    if(part==='echo "GIT_EXIT=${PIPESTATUS[0]}"' || part==="echo" || /^echo (?:'---[A-Za-z0-9 _()/@.\-]{0,60}---'|"---[A-Za-z0-9 _()/\-]{0,40}---")$/.test(part) || part==="echo '---'" || part==='echo "---"'){
      resources.push(part);continue;
    }
    if(part==="pwd" || part==="ls -la" || part==="ls -la ." ||
      (root.startsWith(homedir()+"/") && /^~\/[A-Za-z0-9_.\/-]+$/.test(part.slice(7)) &&
       part.startsWith("ls -la ") && part.slice(7).replace(/^~/,homedir())===root)){
      resources.push(part);continue;
    }
    if(/^git rev-parse (?:--is-inside-work-tree|--abbrev-ref HEAD)(?: 2>&1)?$/.test(part)){
      resources.push(part);continue;
    }
    if(part==='command -v bun >/dev/null 2>&1 && bun -v 2>&1 || echo "bun: NO ENCONTRADO"'){
      resources.push("command -v bun >/dev/null 2>&1","bun -v",'echo "bun: NO ENCONTRADO"');continue;
    }
    if(/^git status(?: --porcelain(?:=v1)?)?(?: 2>&1)?$/.test(part)){
      resources.push(part);continue;
    }
    const status=/^(git status(?: --porcelain(?:=v1)?| --short)?(?: 2>&1)?) \| (head -(?:[1-9]\d?|100))$/.exec(part);
    if(status){resources.push(status[1]!,status[2]!);continue;}
    const units=/^(systemctl --user list-units --type=service --all 2>&1) \| (grep -i [A-Za-z0-9_-]{1,32}) \| (head(?: -(?:[1-9]\d?|100))?)$/.exec(part);
    if(units){resources.push(units[1]!,units[2]!,units[3]!);continue;}
    const sockets=/^\(ss -ltnp 2>\/dev\/null \|\| netstat -ltnp 2>\/dev\/null\) \| (grep ([0-9]{1,5}))$/.exec(part);
    if(sockets && Number(sockets[2])>0 && Number(sockets[2])<=65535){
      resources.push("ss -ltnp 2>/dev/null","netstat -ltnp",sockets[1]!);continue;
    }
    const unit=basename(root).replace(/^\./,"")+".service";
    const service=/^systemctl --user (?:is-active|is-enabled) ([A-Za-z0-9_-]+(?:\.service)?)$/.exec(plain);
    const metadata=/^systemctl --user show ([A-Za-z0-9_-]+(?:\.service)?)((?: -p (?:ActiveState|SubState|MainPID|LoadState|UnitFileState|ExecMainStartTimestamp|FragmentPath|NRestarts)){1,8})$/.exec(plain);
    if([service?.[1],metadata?.[1]].some(name=>name===unit||name+".service"===unit)){resources.push(part);continue;}
    if(plain==="~/.bun/bin/bun --version"){
      try{const bun=resolve(homedir(),".bun/bin/bun");
        if(realpathSync(bun)===bun && lstatSync(bun).isFile()){resources.push(part);continue;}
      }catch{}
    }
    if(plain==="ls .github/workflows" || plain==="ls -d node_modules"){
      const name=plain==="ls .github/workflows"?".github/workflows":"node_modules";
      const file=resolve(root,name);
      try{if(realpathSync(file)!==file || !lstatSync(file).isDirectory())return null;}
      catch(e){
        if((e as NodeJS.ErrnoException).code!=="ENOENT")return null;
        // An absent target can still be behind a symlinked parent.
        if(name.includes("/")){try{const parent=resolve(root,".github");if(realpathSync(parent)!==parent)return null;}catch(err){if((err as NodeJS.ErrnoException).code!=="ENOENT")return null;}}
      }
      resources.push(part);continue;
    }
    // File metadata only; no content reads, wildcards or symlink targets.
    const listing=/^ls -l ([A-Za-z0-9_./ -]+)$/.exec(plain);
    if(listing){
      const files=listing[1]!.split(" ");
      const safe=files.length<=20&&files.every(name=>{
        if(safeSource(root,name))return true;
        // These exact catalog/config paths are valid for a metadata-only
        // check, not for reading or hashing configuration contents.
        if(basename(root).replace(/^\./,"")!=="zen-proxy"||
          !/^(?:models|zen-proxy)\.json(?:\.bak\.pre-catalog-refresh)?$/.test(name))return false;
        try{const file=resolve(root,name);return realpathSync(file)===file&&lstatSync(file).isFile();}catch{return false;}
      });
      if(!safe)return null;
      resources.push(part);continue;
    }
    const localRead=assessIndependentDiagnostic(part,root);
    if(localRead){resources.push(...localRead.resources);continue;}
    if(plain.startsWith("sha256sum ")){
      const files=plain.slice(10).split(" ");
      if(files.length>0&&files.length<=20&&files.every(f=>safeSource(root,f))){
        resources.push(part);continue;
      }
    }
    // Hash public source without writing a downloaded file. The repo must
    // be named in the round and the local counterpart must be safe.
    const catalogDigest=/^(curl -sS --max-time (?:[1-9]|[1-5]\d|60) https:\/\/raw\.githubusercontent\.com\/([A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+)\/(?:main|master)\/([A-Za-z0-9_./-]+)) \| sha256sum$/.exec(part);
    if(catalogDigest && safeSource(root,catalogDigest[3]!) && repoMentioned(instructions,catalogDigest[2]!) && curlDefaultsAbsent()){
      resources.push(catalogDigest[1]!,"sha256sum");continue;
    }
    const publicRead=publicMetadata(part,instructions);
    if(publicRead){resources.push(...publicRead);continue;}
    if(requestedPublicRepo(plain,instructions,root)){resources.push(part);continue;}
    return null;
  }
  return resources.length>0 ? {category:"inspection",resources}:null;
}
export function matchDiagnosticResources(actual:string[],expected:string[]):boolean{
  // OpenCode 2.x drops the stderr redirection on its fallback netstat segment.
  const normalize=(s:string)=>s==="netstat -ltnp 2>/dev/null"?"netstat -ltnp":
    /^(?:npm test(?: -- --test-reporter=spec)?|git status --short|git ls-remote https:\/\/github\.com\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+ refs\/heads\/(?:main|master)) 2>&1$/.test(s)?s.slice(0,-5):s;
  return actual.length===expected.length && actual.every((s,i)=>normalize(s)===normalize(expected[i]!));
}

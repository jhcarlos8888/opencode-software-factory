import { lstatSync, realpathSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { isSensitiveFilesystemPath } from "./filesystem-guards.js";

export function isDiagnosticCandidate(command: string): boolean {
  return /(?:^|; | && )(?:(?:node|npm|bun|git) --version|ls -la(?: |$)|curl -fsSL --max-time |systemctl --user (?:list-units|show|is-active|is-enabled)|~\/\.bun\/bin\/bun --version|sha256sum |npm (?:test|pack --dry-run)(?: |$)|git ls-remote https:\/\/github\.com\/)/.test(command);
}
function canonicalRoot(root: string): boolean {
  try { return isAbsolute(root) && realpathSync(root) === root && lstatSync(root).isDirectory(); }
  catch { return false; }
}
function safeSource(root: string, name: string): boolean {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/.test(name) ||
      name.split("/").some(p=>p===".."||p==="." ) || isSensitiveFilesystemPath(name) ||
      !/^(?:package\.json|models\.json|README\.md|LICENSE|zen-proxy|[A-Za-z0-9_./-]+\.(?:mjs|cjs|js|ts|java|sh|md))$/.test(name)) return false;
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
  const m=/^(curl -fsSL --max-time (?:[1-9]|[1-5]\d|60) (?:'([^']+)'|([^\s'"]+))(?: 2>\/dev\/null)?)(?: \| (head -c (?:[1-9]\d{0,3}|10000)))?$/.exec(part);
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
type Recipe = { category:"inspection"|"test"; resources:string[] };
/** Classify the exact complete native command, not a set of independent
 * wildcard grants. Only explicit bounded recipes, no arbitrary shell. */
export function assessDiagnosticCommand(command:string,root:string,cwd:string|undefined,instructions=""):Recipe|null {
  if(cwd!==root || !canonicalRoot(root) || command.length>2400 ||
    /[\r\n\x00-\x1f\x60\\]/.test(command))return null;
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
  const loop=/^for f in ([A-Za-z0-9_. -]+); do (printf '%s  ' "\$f"); (curl -fsSL --max-time (?:[1-9]|[1-5]\d|60) "https:\/\/raw\.githubusercontent\.com\/([A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+)\/(?:main|master)\/\$f") \| sha256sum; done(?:; |$)/.exec(remainder);
  if(loop){
    const files=loop[1]!.split(" ");
    if(files.length>20 || !files.every(f=>safeSource(root,f)) || !repoMentioned(instructions,loop[4]!) || !curlDefaultsAbsent())return null;
    resources.push(loop[2]!,loop[3]!,"sha256sum");
    remainder=remainder.slice(loop[0].length);
  }
  const parts=remainder?remainder.split(/; | && /):[];
  if(parts.length>12)return null;
  for(const part of parts){
    const plain=part.replace(/ 2>&1$/,"");
    if(/^(?:node|npm|bun|git) --version$/.test(plain)){
      resources.push(part);continue;
    }
    if(part==="echo" || /^echo (?:'---[A-Za-z0-9 _()/@.\-]{0,60}---'|"---[A-Za-z0-9 _()/\-]{0,40}---")$/.test(part) || part==="echo '---'" || part==='echo "---"'){
      resources.push(part);continue;
    }
    if(part==="ls -la" || part==="ls -la ." ||
      (root.startsWith(homedir()+"/") && /^~\/[A-Za-z0-9_.\/-]+$/.test(part.slice(7)) &&
       part.startsWith("ls -la ") && part.slice(7).replace(/^~/,homedir())===root)){
      resources.push(part);continue;
    }
    if(/^git status(?: --porcelain(?:=v1)?)?(?: 2>&1)?$/.test(part)){
      resources.push(part);continue;
    }
    const status=/^(git status(?: --porcelain(?:=v1)?)?(?: 2>&1)?) \| (head -(?:[1-9]\d?|100))$/.exec(part);
    if(status){resources.push(status[1]!,status[2]!);continue;}
    const units=/^(systemctl --user list-units --type=service --all 2>&1) \| (grep -i [A-Za-z0-9_-]{1,32}) \| (head(?: -(?:[1-9]\d?|100))?)$/.exec(part);
    if(units){resources.push(units[1]!,units[2]!,units[3]!);continue;}
    const sockets=/^\(ss -ltnp 2>\/dev\/null \|\| netstat -ltnp 2>\/dev\/null\) \| (grep ([0-9]{1,5}))$/.exec(part);
    if(sockets && Number(sockets[2])>0 && Number(sockets[2])<=65535){
      resources.push("ss -ltnp 2>/dev/null","netstat -ltnp",sockets[1]!);continue;
    }
    const unit=basename(root).replace(/^\./,"")+".service";
    const service=/^systemctl --user (?:is-active|is-enabled) ([A-Za-z0-9_-]+\.service)$/.exec(plain);
    const metadata=/^systemctl --user show ([A-Za-z0-9_-]+\.service)((?: -p (?:ActiveState|SubState|MainPID|LoadState|UnitFileState)){1,5})$/.exec(plain);
    if(service?.[1]===unit || metadata?.[1]===unit){resources.push(part);continue;}
    if(plain==="~/.bun/bin/bun --version"){
      try{const bun=resolve(homedir(),".bun/bin/bun");
        if(realpathSync(bun)===bun && lstatSync(bun).isFile()){resources.push(part);continue;}
      }catch{}
    }
    if(plain.startsWith("sha256sum ")){
      const files=plain.slice(10).split(" ");
      if(files.length>0&&files.length<=20&&files.every(f=>safeSource(root,f))){
        resources.push(part);continue;
      }
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
  const normalize=(s:string)=>s==="netstat -ltnp 2>/dev/null"?"netstat -ltnp":s;
  return actual.length===expected.length && actual.every((s,i)=>normalize(s)===normalize(expected[i]!));
}

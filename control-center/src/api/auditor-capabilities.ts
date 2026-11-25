/**
 * Capability-based audit of a small, non-executable shell grammar.
 * Only native input is classified. The parser does not execute commands,
 * expand globs, consult shell variables, or accept arbitrary shell programs.
 * External scopes come exclusively from explicit user round declarations.
 */
import { lstatSync, realpathSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { isSensitiveFilesystemPath } from "./filesystem-guards.js";
import { assessIndependentDiagnostic } from "./diagnostic-policy.js";

export type CapabilityScope = { roots: string[]; metadata: string[]; configs: string[]; markers: string[]; testRoots: string[]; };
type Chunk = { text: string; after: string };
type Word = { raw: string; value: string };
const aliases = new Set(["A","B","D","F","F1","F2","G","P","BASE","ROOT","PROJECT","FACTORY"]);
const loopAliases = new Set(["p","d","f","F","c","u","n","l"]);
const redirections = new Set(["2>&1","2>/dev/null",">/dev/null"]);
const controlChars = /[\x00-\x08\x0b-\x1f\x7f]/;
const safePath = /^[\p{L}\p{N} _.,/@:+()-]+$/u;
const sourceExt = new Set([".ts",".tsx",".js",".jsx",".mjs",".cjs",".java",".kt",".go",".rs",".py",".sh",".md",".txt",".xml",".gradle",".sql",".css",".html",".yaml",".yml",".toml",".json"]);
const maxBytes=1024*1024;

function within(root:string,path:string):boolean {
  const r=relative(root,path);
  return r==="" || (r!==".."&&!r.startsWith("../")&&!isAbsolute(r));
}
function canonical(path:string, allowMissing=false):boolean {
  if(!isAbsolute(path)||resolve(path)!==path||!safePath.test(path))return false;
  let current=path;
  for(;;){
    try{
      const st=lstatSync(current);
      return !st.isSymbolicLink() && realpathSync(current)===current &&
        (current===path || st.isDirectory());
    }catch(e){
      if(!allowMissing||(e as NodeJS.ErrnoException).code!=="ENOENT")return false;
      const parent=dirname(current);if(parent===current)return false;current=parent;
    }
  }
}
/** Each declaration occupies its own line. No model-supplied path can grant
 * authority. No home-wide, root-wide or Documents-wide read roots. */
export function buildCapabilityScope(root:string,instructions=""):CapabilityScope {
  const scope:CapabilityScope={roots:[],metadata:[],configs:[],markers:[],testRoots:[]};
  const home=homedir();
  const forbidden=new Set(["/",home,dirname(home),resolve(home,"Documents"),"/etc","/usr","/var","/tmp","/proc","/sys","/dev","/run"]);
  if(!forbidden.has(root)&&!isSensitiveFilesystemPath(root)&&canonical(root)&&lstatSync(root).isDirectory()){
    scope.roots.push(root);
    scope.testRoots.push(root);
  }
  for(const line of instructions.split(/\r?\n/)){
    const markers=/^\s*AUDITOR_MARKERS:\s*([A-Za-z0-9_.:/ -]+(?:,[A-Za-z0-9_.:/ -]+){0,15})\s*$/.exec(line);
    if(markers){scope.markers.push(...markers[1]!.split(",").map(v=>v.trim()).filter(v=>v.length>0&&v.length<=80));continue;}
    const m=/^\s*AUDITOR_(READ_ROOT|METADATA_PATH|CONFIG_FILE|TEST_ROOT):\s*(.*?)\s*$/.exec(line);
    if(!m || scope.roots.length+scope.metadata.length+scope.configs.length>=48)continue;
    const value=m[2]!.replace(/^~\//,home+"/").replace(/\/$/,"");
    if(!isAbsolute(value)||forbidden.has(value)||!canonical(value,m[1]==="METADATA_PATH"))continue;
    if(m[1]==="READ_ROOT"||m[1]==="TEST_ROOT"){
      if(isSensitiveFilesystemPath(value)||!within(home,value)||!lstatSync(value).isDirectory())continue;
      // Require a project marker, not a personal umbrella directory.
      if(![".git","package.json","pom.xml","build.gradle","build.gradle.kts","pyproject.toml","go.mod","Cargo.toml","opencode.json"].some(n=>{
        try{return canonical(resolve(value,n))&&(lstatSync(resolve(value,n)).isFile()||lstatSync(resolve(value,n)).isDirectory());}catch{return false;}
      }))continue;
      if(m[1]==="TEST_ROOT")scope.testRoots.push(value);else scope.roots.push(value);
    }else if(m[1]==="CONFIG_FILE"){
      if(!within(home,value)||!value.endsWith(".json")||!lstatSync(value).isFile()||relative(home,value).split("/").some(part=>/^(?:\.ssh|\.gnupg|\.aws|\.kube|\.azure|\.password-store|keyrings)$/i.test(part))||/auth|credential|secret|token|keychain|session|history/i.test(basename(value)))continue;
      scope.configs.push(value);
    }else {
      // Metadata on one exact path only; never creates an external subtree grant.
      if(!within(home,value)&&!/^\/etc\/systemd\/system\/[A-Za-z0-9_.@-]+\.service$/.test(value))continue;
      scope.metadata.push(value);
    }
  }
  return scope;
}
function splitShell(command:string):Chunk[]|null{
  if(command.length>10000||controlChars.test(command)||command.includes("\x60")||command.includes("\r"))return null;
  let quote="",start=0;const out:Chunk[]=[];
  const push=(i:number,after:string,len:number)=>{
    const text=command.slice(start,i).trim();if(text)out.push({text,after});
    else if(after!=="\n"&&after!==";")throw Error("empty");
    start=i+len;
  };
  try{
    for(let i=0;i<command.length;i++){
      const c=command[i]!;
      if(quote){if(c===quote)quote="";else if(quote==='"'&&(c==="\\"||c==="$"&&command[i+1]==="("))return null;continue;}
      if(c==="'"||c==='"'){quote=c;continue;}
      if(c==="\\")return null;
      if(command.startsWith("2>&1",i)){i+=3;continue;}
      if(command.startsWith("2>/dev/null",i)){i+=10;continue;}
      if(command.startsWith(">/dev/null",i)){i+=9;continue;}
      if(c===">"||c==="<"||c==="("||c===")"||c==="{"||c==="}"||c==="#"||c==="&"&&command[i+1]!=="&")return null;
      if(c===";"||c==="\n"||c==="|"||c==="&"){
        const op=(c==="|"||c==="&")&&command[i+1]===c?c+c:c;
        push(i,op,op.length);i+=op.length-1;
      }
    }
    if(quote)return null;
    const last=command.slice(start).trim();if(last)out.push({text:last,after:""});
    return out.length&&out.length<=96?out:null;
  }catch{return null;}
}
/** Decode only literal shell words and quoted references to validated aliases.
 * No unquoted variable expansion, command substitution, pathname expansion,
 * brace expansion, tilde expansion or environment lookup. */
function words(text:string,vars:Map<string,string>):Word[]|null{
  let q="",raw="",value="";const out:Word[]=[];
  const flush=()=>{if(raw){out.push({raw,value});raw="";value="";}};
  for(let i=0;i<text.length;i++){
    const c=text[i]!;
    if(!q&&/\s/.test(c)){flush();continue;}
    if(!q&&(c==="'"||c==='"')){q=c;raw+=c;continue;}
    if(q&&c===q){q="";raw+=c;continue;}
    if(q==='"'&&c==="$"){
      const m=/^\$([A-Za-z_][A-Za-z0-9_]*|\?)/.exec(text.slice(i));
      if(!m)return null;
      const v=m[1]==="?"?"__AUDITOR_EXIT__":vars.get(m[1]!);
      if(v===undefined)return null;
      raw+=m[0];value+=v;i+=m[0].length-1;continue;
    }
    if(!q&&c==="$")return null;
    if(!q&&/[*?[\]~\\]/.test(c)){
      if((c!=="["&&c!=="]")||raw||i+1<text.length&&!/\s/.test(text[i+1]!))return null;
    }
    if(!q&&/[<>&|;(){}]/.test(c)){
      const redirect=[...redirections].find(x=>text.startsWith(x,i-(raw==="2"?1:0)));
      if(!redirect)return null;
      // A redirect must be a separate complete word.
      const start=i-(raw==="2"?1:0);if(raw&&raw!=="2")return null;
      const end=start+redirect.length;
      if(end<text.length&&!/\s/.test(text[end]!))return null;
      raw=redirect;value=redirect;i=end-1;flush();continue;
    }
    if(q==='"'&&c==="\\")return null;
    raw+=c;value+=c;
  }
  if(q)return null;flush();return out.length<=80?out:null;
}
function resolvePath(value:string,root:string):string|null{
  if(!value||!safePath.test(value)||value.split("/").includes("..")||value.includes("__AUDITOR_EXIT__"))return null;
  return resolve(root,value);
}
function allowedPath(value:string,root:string,scope:CapabilityScope,kind:"metadata"|"source"|"config"):string|null{
  const path=resolvePath(value,root);if(!path)return null;
  const inRoot=scope.roots.some(r=>within(r,path));
  const external=scope.metadata.includes(path)||scope.configs.includes(path);
  if(!inRoot&&!external)return null;
  if(!canonical(path,kind==="metadata"))return null;
  if(kind==="metadata")return path;
  if(/^(?:auth|session|history|credentials?|secrets?|tokens?)(?:[._-]|$)/i.test(basename(path)))return null;
  const rel=scope.roots.find(r=>within(r,path));
  if(kind==="config"&&scope.configs.includes(path)){
    try{const s=lstatSync(path);return s.isFile()&&s.nlink===1&&s.size<=maxBytes&&s.uid===process.getuid?.()?path:null;}catch{return null;}
  }
  if(!rel||isSensitiveFilesystemPath(relative(rel,path)))return null;
  try{
    const st=lstatSync(path);
    if(!st.isFile()||st.nlink!==1||st.size>maxBytes||!sourceExt.has(extname(path)))return null;
    if(kind==="config"&&!path.endsWith(".json"))return null;
    if(kind==="source"&&path.endsWith(".json"))return null;
    return path;
  }catch{return null;}
}
function isSafeKey(key:unknown):boolean{return typeof key==="string"&&/^[A-Za-z0-9_.$/@:+ -]{1,120}$/.test(key);}
function safeConfigProjection(file:string,expr:string,discard:boolean):boolean{
  try{
    const j=JSON.parse(readFileSync(file,"utf8"));
    if(expr==='type=="object"'||expr==="type == \"object\"")return true;
    if(expr==="."&&discard)return true;
    if(!j||typeof j!=="object"||Array.isArray(j))return false;
    const flat=(s:unknown)=>s===null||s===undefined||typeof s==="string"&&/^[A-Za-z0-9_./:@+-]{1,150}$/.test(s);
    const obj=(s:unknown)=>s!==null&&typeof s==="object"&&!Array.isArray(s);
    const keys=(s:unknown)=>obj(s)&&Object.keys(s as object).length<=512&&Object.keys(s as object).every(isSafeKey);
    const normalized=expr.replace(/\s*\|\s*/g,"|");
    if(["keys","keys[]","keys|length",'keys|join(",")'].includes(normalized))return normalized==="keys|length"||keys(j);
    if(/^\.(?:provider|providers|scripts|variant)\|(?:keys|keys\[\]|keys\|length|keys\|join\(","\))$/.test(normalized)){
      const field=normalized.slice(1,normalized.indexOf("|"));return keys(j[field]);
    }
    if(/^\.(?:recent|favorite|variant)\|length$/.test(normalized))return true;
    if(/^\.(?:model|small_model|default_agent) \/\/ "(?:none|unset)"$/.test(expr))return flat(j[expr.split(" ")[0]!.slice(1)]);
    if(expr==="{model: .model, default_agent: .default_agent}"||expr==='{model, default_agent: (.default_agent // "unset")}')return flat(j.model)&&flat(j.default_agent);
    // Count matching key paths only: fixed syntax, simple literal alternatives,
    // no scalar-value predicates, no arbitrary jq programs.
    if(/^\[paths\(scalars\) as \$p \| select\(\$p\|join\("\."\)\|test\("[A-Za-z0-9_-]+(?:\|[A-Za-z0-9_-]+){0,7}"\)\)\] \| length$/.test(expr))return true;
    if(/^\.(?:provider|providers)\["[A-Za-z0-9_-]{1,80}"\]\s*==\s*null$/.test(expr))return true;
    if(/^\{providers: \(\.provider \/\/ \.providers \/\/ "none" \| if type=="object" then keys else \. end\), zen: \(\[paths\(scalars\) as \$p \| select\(\$p\|join\("\."\)\|test\("[A-Za-z0-9_-]+(?:\|[A-Za-z0-9_-]+){0,7}"\)\)\] \| length\)\}$/.test(expr)){
      const provider=j.provider??j.providers??"none";return provider==="none"||keys(provider);
    }
    return false;
  }catch{return false;}
}
function safeSourceLines(file:string):boolean{
  // Source reads are still bounded and never applied to recognized secret files.
  try{
    const text=readFileSync(file,"utf8");
    return !text.includes("\0")&&!/(?:api[_-]?key|password|secret|token)\s*[:=]\s*["'][A-Za-z0-9_./+-]{12,}/i.test(text);
  }catch{return false;}
}
function safeFileSearch(paths:string[],root:string,scope:CapabilityScope,exclude:Set<string>):boolean{
  let count=0,bytes=0;
  function visit(path:string,depth:number):boolean{
    if(++count>3500||depth>16||!canonical(path))return false;
    const st=lstatSync(path);
    const r=scope.roots.find(r=>within(r,path));if(!r)return false;
    if(isSensitiveFilesystemPath(relative(r,path))||/^(?:auth|session|history|credentials?|secrets?|tokens?)(?:[._-]|$)/i.test(basename(path)))return false;
    if(st.isDirectory()){
      for(const d of readdirSync(path,{withFileTypes:true})){
        if(d.isDirectory()&&exclude.has(d.name))continue;
        if(!visit(resolve(path,d.name),depth+1))return false;
      }
      return true;
    }
    if(!st.isFile()||st.nlink!==1||st.size>maxBytes)return false;
    bytes+=st.size;
    // A name-only scan may include non-source binary artifacts only if grep -I
    // is used; require an ordinary non-sensitive source file either way.
    return bytes<=24*maxBytes && (sourceExt.has(extname(path))||/^(?:README|LICENSE|Makefile|Dockerfile|\.gitignore)$/.test(basename(path)));
  }
  try{return paths.every(p=>{const v=resolvePath(p,root);return !!v&&visit(v,0);});}catch{return false;}
}
function literalPattern(x:string):boolean{return /^[A-Za-z0-9_./: -]{1,100}(?:\|[A-Za-z0-9_./: -]{1,100}){0,12}$/.test(x);}
function approveSegment(chunk:Chunk,root:string,scope:CapabilityScope,vars:Map<string,string>,previous: boolean):boolean{
  const parsed=words(chunk.text,vars);if(!parsed?.length)return false;
  const tokens=parsed.filter(w=>!redirections.has(w.raw));
  const a=tokens.map(w=>w.value),[cmd,...args]=a;
  const redirects=parsed.filter(w=>redirections.has(w.raw)).map(w=>w.raw);
  const discard=redirects.includes(">/dev/null");
  if(!cmd||a.some(v=>v.length>4096))return false;
  if(cmd==="set")return !previous&&((args.length===1&&["+e","-e","-eu"].includes(args[0]!))||(args.length===2&&args[0]==="-euo"&&args[1]==="pipefail"))&&!redirects.length;
  if(cmd==="echo")return args.length<=4&&args.every(v=>/^[\p{L}\p{N} _.,/@:+()=\-?]{0,512}$/u.test(v)||v==="__AUDITOR_EXIT__")&&!discard;
  if(cmd==="printf")return args.length===2&&["%s: ","%s -> ","%s\n"].includes(args[0]!)&&safePath.test(args[1]!)&&!discard;
  if(cmd==="pwd")return args.length===0;
  if(cmd==="command")return args.length>=2&&args.length<=5&&args[0]==="-v"&&args.slice(1).every(v=>/^[A-Za-z0-9_.-]{1,64}$/.test(v));
  if(cmd==="ls"){
    const opts=args.filter(x=>x.startsWith("-"));const files=args.filter(x=>!x.startsWith("-"));
    if(opts.some(x=>!/^-[lad1]{1,4}$/.test(x))||files.length>20)return false;
    const targets=files.length?files:["."];
    return targets.every(x=>{
      const p=allowedPath(x,root,scope,"metadata");if(!p)return false;
      // An exact external directory may be stat'ed, but not enumerated.
      const r=scope.roots.find(r=>within(r,p));
      const metadataOnly=opts.some(o=>o.includes("d"));
      if(r){
        if(isSensitiveFilesystemPath(relative(r,p))||/^(?:auth|session|history)(?:[._-]|$)/i.test(basename(p))){
          return metadataOnly || !canonical(p) || lstatSync(p).isFile();
        }
        return true;
      }
      return metadataOnly || !canonical(p) || lstatSync(p).isFile();
    });
  }
  if(cmd==="test"||cmd==="["){
    const t=cmd==="["&&args.at(-1)==="]"?args.slice(0,-1):args;
    return t.length===2&&["-e","-f","-d"].includes(t[0]!)&&!!allowedPath(t[1]!,root,scope,"metadata");
  }
  if(cmd==="stat")return args.length===3&&args[0]==="-c"&&["%a","%U","%u","%s","%F"].includes(args[1]!)&&!!allowedPath(args[2]!,root,scope,"metadata");
  if(cmd==="jq"){
    if(args.length!==3||!/^-(?:r|e|c)$/.test(args[0]!))return false;
    const file=allowedPath(args[2]!,root,scope,"config");
    return !!file&&safeConfigProjection(file,args[1]!,discard);
  }
  if(cmd==="sed"){
    if(args.length!==3||args[0]!=="-n"||!/^\d{1,6},\d{1,6}p(?:;\d{1,6},\d{1,6}p){0,4}$/.test(args[1]!))return false;
    const ranges=args[1]!.split(";").map(r=>r.slice(0,-1).split(",").map(Number));
    if(ranges.some(([lo,hi])=>lo!<1||hi!<lo!)||ranges.reduce((n,[lo,hi])=>n+hi!-lo!+1,0)>400)return false;
    const file=allowedPath(args[2]!,root,scope,"source");return !!file&&safeSourceLines(file);
  }
  if(cmd==="head"||cmd==="tail"){
    if(!args.length)return false;
    const opt=args[0]!,bytes=opt==="-c",n=bytes?Number(args[1]):Number(opt.slice(1));
    if(!Number.isInteger(n)||n<1||n>(bytes?10000:400)||!bytes&&!/^-\d+$/.test(opt))return false;
    const rest=args.slice(bytes?2:1);
    if(!rest.length)return previous;
    if(rest.length!==1)return false;
    const file=allowedPath(rest[0]!,root,scope,"source");return !!file&&safeSourceLines(file);
  }
  if(previous&&cmd==="cut")return args.length===1&&/^-c1-[1-9]\d{0,2}$/.test(args[0]!);
  if(previous&&cmd==="sort")return args.length===1&&args[0]==="-u";
  if(previous&&cmd==="wc")return args.length===1&&args[0]==="-l";
  if(cmd==="grep"){
    let recursive=false,names=false,count=false,pattern=false,flags="",paths:string[]=[],patterns:string[]=[];const excludes=new Set<string>();
    for(let i=0;i<args.length;i++){
      const v=args[i]!;
      if(v==="-e"){const term=args[++i]??"";if(!literalPattern(term))return false;patterns.push(term);pattern=true;continue;}
      if(v.startsWith("--exclude-dir=")){const n=v.slice(14);if(!/^[A-Za-z0-9_.-]{1,64}$/.test(n))return false;excludes.add(n);continue;}
      if(/^-[rIlcnEF]{1,7}$/.test(v)){flags+=v.slice(1);continue;}
      if(v.startsWith("-"))return false;
      if(!pattern){if(!literalPattern(v))return false;patterns.push(v);pattern=true;continue;}
      paths.push(v);
    }
    recursive=flags.includes("r");names=flags.includes("l");count=flags.includes("c");
    if(!pattern||paths.length>16||recursive&&!names||names&&flags.includes("n"))return false;
    if(previous&&!paths.length)return !recursive;
    if(!paths.length)return false;
    if(recursive)return safeFileSearch(paths,root,scope,excludes);
    return paths.every(x=>{
      const f=allowedPath(x,root,scope,"source");
      if(f)return names||count||safeSourceLines(f);
      const config=allowedPath(x,root,scope,"config");
      return !!config && count && !names && !flags.includes("n") &&
        patterns.flatMap(p=>p.split("|")).every(term=>scope.markers.includes(term));
    });
  }
  if(cmd==="systemctl"){
    const x=args[0]==="--user"?args.slice(1):args;
    const unit=basename(root).replace(/^\./,"")+".service";
    const allowed=new Set([unit,"factory-control-center.service"]);
    if(["is-active","is-enabled"].includes(x[0]??""))return x.length===2&&allowed.has(x[1]!);
    if(x[0]==="show"&&allowed.has(x[1]!)&&x.length>=4&&x.length<=20&&x.length%2===0){
      const props=new Set(["LoadState","ActiveState","SubState","UnitFileState","MainPID","FragmentPath","ExecMainStartTimestamp","InactiveEnterTimestamp","ExecMainStatus","NRestarts"]);
      return x.slice(2).every((v,i)=>i%2===0?v==="-p":props.has(v));
    }
    if(x[0]==="list-unit-files"&&x.length===2&&x[1]===unit.replace(/\.service$/,"")+"*"&&tokens.at(-1)?.raw.startsWith("'"))return true;
    return false;
  }
  if(cmd==="pgrep"&&args.length===3&&args[0]==="-c"&&args[1]==="-x"&&/^[A-Za-z0-9_-]{1,40}$/.test(args[2]!))return true;
  if(cmd==="curl"){
    const url=args.at(-1)??"";
    const safe=/^http:\/\/127\.0\.0\.1:(4141|4173)\/(?:api\/health|health|api\/status)?$/.test(url);
    if(!safe||args.length!==8||args[0]!=="-s"||args[1]!=="-m"||!/^[1-9]$/.test(args[2]!)||args[3]!=="-o"||args[4]!=="/dev/null"||args[5]!=="-w"||!["%{http_code}\\n","code=%{http_code}\\n"].includes(args[6]!))return false;
    const locations=[resolve(homedir(),".curlrc"),resolve(homedir(),".config/curlrc")];
    if(process.env.CURL_HOME)locations.push(resolve(process.env.CURL_HOME,".curlrc"));
    if(process.env.XDG_CONFIG_HOME)locations.push(resolve(process.env.XDG_CONFIG_HOME,"curlrc"));
    if(["http_proxy","HTTP_PROXY","all_proxy","ALL_PROXY"].some(k=>process.env[k])&&!((process.env.no_proxy??process.env.NO_PROXY??"").split(",").some(v=>v.trim()==="127.0.0.1"||v.trim()==="*")))return false;
    return locations.every(f=>{try{lstatSync(f);return false;}catch(e){return (e as NodeJS.ErrnoException).code==="ENOENT";}});
  }
  // Reuse existing narrow diagnostic capabilities for tools and services,
  // but only on a complete literal segment (no unverified variable rewriting).
  if(!previous&&tokens.every(w=>!w.raw.includes("$"))&&assessIndependentDiagnostic(chunk.text,root))return true;
  return false;
}

/**
 * Classify a complete sequence of read-only capabilities. All executable
 * segments are checked, including every expansion of a finite literal loop.
 * The returned resource list is the provider-facing original syntax, not an
 * expanded command or a reusable approval pattern.
 */
export function assessCapabilityCommand(command:string,root:string,cwd:string|undefined,instructions=""): {category:"inspection";resources:string[]}|null{
  if(cwd!==root||!canonical(root))return null;
  const chunks=splitShell(command);if(!chunks)return null;
  const scope=buildCapabilityScope(root,instructions);
  const vars=new Map<string,string>([["HOME",homedir()]]);
  const resources:string[]=[];
  let expanded=0;
  function sequence(items:Chunk[],env:Map<string,string>,record:boolean,allowLoop:boolean):boolean{
    let previous=false, seenExecutable=false;
    for(let i=0;i<items.length;i++){
      let chunk=items[i]!;
      if(++expanded>256)return false;
      const text=chunk.text;
      if(text.startsWith("for ")){
        if(!allowLoop||previous||![";","\n"].includes(chunk.after)||i>0&&![";","\n"].includes(items[i-1]!.after))return false;
        const w=words(text,env);
        if(!w||w.length<4||w[0]!.value!=="for"||!loopAliases.has(w[1]!.value)||w[2]!.value!=="in"||w.length>27)return false;
        const values=w.slice(3).map(x=>x.value);
        if(values.some(v=>!safePath.test(v)))return false;
        const body:Chunk[]=[];
        let end=i+1;const first=items[end];
        if(!first||!/^do(?:\s|$)/.test(first.text))return false;
        const firstBody=first.text.slice(2).trim();if(firstBody)body.push({...first,text:firstBody});end++;
        for(;end<items.length&&items[end]!.text!=="done";end++)body.push(items[end]!);
        if(end>=items.length||!body.length||items[end]!.after==="|"||body.some(x=>/^for\b/.test(x.text)))return false;
        for(let n=0;n<values.length;n++){
          const local=new Map(env);local.set(w[1]!.value,values[n]!);
          if(!sequence(body,local,record&&n===0,false))return false;
        }
        env.delete(w[1]!.value);i=end;previous=false;seenExecutable=true;continue;
      }
      const assignment=/^([A-Za-z][A-Za-z0-9_]*)=(.+)$/.exec(text);
      if(assignment){
        if(!allowLoop||seenExecutable||previous||!aliases.has(assignment[1]!)||![";","\n"].includes(chunk.after)||i>0&&![";","\n"].includes(items[i-1]!.after))return false;
        const w=words(assignment[2]!,env);
        if(!w||w.length!==1||!isAbsolute(w[0]!.value)||!safePath.test(w[0]!.value)||w[0]!.value.split("/").includes(".."))return false;
        env.set(assignment[1]!,w[0]!.value);continue;
      }
      if(text!=="set +e"&&text!=="set -e"&&text!=="set -eu"&&text!=="set -euo pipefail")seenExecutable=true;
      // A pipe producer may be a literal trusted recipe with its exact
      // filter. This preserves prior bounds without accepting free pipes.
      if(chunk.after==="|"&&i+1<items.length){
        const next=items[i+1]!;
        const pair=chunk.text+" | "+next.text;
        const socket= /^ss -ltnp? 2>\/dev\/null$/.test(chunk.text) &&
          /^grep -(?:F|E|c) ':(?:4141|4173|8787)(?:\|:(?:4141|4173|8787)){0,2}'$/.test(next.text);
        if(socket&&!previous&&(!next.text.includes(":8787")||basename(root).replace(/^\./,"")==="zen-proxy")){
          if(record)resources.push(chunk.text,next.text);
          i++;previous=next.after==="|";continue;
        }
        const prior=assessIndependentDiagnostic(pair,root);
        if(!previous&&prior){
          if(record)resources.push(...prior.resources);
          i++;previous=next.after==="|";continue;
        }
      }
      if(!approveSegment(chunk,root,scope,env,previous))return false;
      if(record)resources.push(chunk.text);
      previous=chunk.after==="|";
    }
    return !previous;
  }
  try{
    if(!sequence(chunks,vars,true,true)||!resources.length||resources.length>64)return null;
    return {category:"inspection",resources};
  }catch{return null;}
}


/** The complete native command must account for every legacy segment too.
 * This does not classify it; the old closed policy still checks each segment. */
export function nativeSegmentResources(command:string):string[]|null {
  const chunks=splitShell(command);if(!chunks)return null;
  if(chunks.some(x=>/^(?:for|if|while|case|function)\b/.test(x.text)||/^[A-Za-z_][A-Za-z0-9_]*=/.test(x.text)))return null;
  return chunks.map(x=>x.text);
}

/** A test root is deliberately different from a read root: invoking npm
 * executes workspace code. Require explicit scope for external projects,
 * exact known test scripts, a canonical manifest, and no arbitrary arguments. */
export function assessScopedTestCommand(command:string,root:string,cwd:string|undefined,instructions=""): {category:"test";resources:string[]}|null{
  if(cwd!==root||!canonical(root)||command.length>1600)return null;
  const m=/^(?:cd "([^"$\x60\\]+)" && )?(npm (?:test|run (?:verify|check|test:unit|smoke|typecheck)))(?: 2>&1(?: \| (tail -(?:[1-9]\d?|100)); (echo "(?:EXIT|EXIT_CODE|TEST_EXIT|CHECK_EXIT|UNIT_EXIT|SMOKE_EXIT)=\$\{PIPESTATUS\[0\]\}"))?)?$/.exec(command);
  if(!m)return null;
  const target=m[1]??root;
  const scope=buildCapabilityScope(root,instructions);
  if(!scope.testRoots.includes(target))return null;
  const manifest=resolve(target,"package.json");
  if(!canonical(manifest))return null;
  try{
    const st=lstatSync(manifest);if(!st.isFile()||st.size>256*1024)return null;
    const p=JSON.parse(readFileSync(manifest,"utf8"));
    const name=m[2]==="npm test"?"test":m[2]!.slice(8);
    if(!p.scripts||typeof p.scripts[name]!=="string"||!p.scripts[name].trim()||p.workspaces||p.scripts["pre"+name]||p.scripts["post"+name])return null;
    // User-authorized project tests may execute its code; no external shell
    // program or extra arguments are introduced by the permission request.
    const resource=m[2]!+(command.includes(" 2>&1")?" 2>&1":"");
    return {category:"test",resources:[...(m[1]?['cd "'+target+'"']:[]),resource,...(m[3]?[m[3],m[4]!]:[])]};
  }catch{return null;}
}

export function validateCapabilityScopeInput(root:string,raw:unknown):{declarations:string;scope:CapabilityScope}{
  if(raw===undefined||raw===null||raw==="")return {declarations:"",scope:buildCapabilityScope(root)};
  if(typeof raw!=="string"||raw.length>8000||controlChars.test(raw.replace(/\r/g,"")))throw new Error("Alcance adicional del Auditor inválido.");
  const lines=raw.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  if(lines.length>40)throw new Error("El alcance adicional admite hasta 40 declaraciones por ronda.");
  const clean:string[]=[];
  for(const line of lines){
    const match=/^AUDITOR_(READ_ROOT|METADATA_PATH|CONFIG_FILE|TEST_ROOT|MARKERS):\s*(.+)$/.exec(line);
    if(!match)throw new Error("Declaración de alcance no reconocida: usa AUDITOR_READ_ROOT, AUDITOR_METADATA_PATH, AUDITOR_CONFIG_FILE, AUDITOR_TEST_ROOT o AUDITOR_MARKERS.");
    const value=match[2]!.replace(/^~\//,homedir()+"/").replace(/\/$/,"");
    const normalized="AUDITOR_"+match[1]+": "+value;
    const result=buildCapabilityScope(root,normalized);
    const accepted=match[1]==="READ_ROOT"?result.roots.includes(value):
      match[1]==="TEST_ROOT"?result.testRoots.includes(value):
      match[1]==="CONFIG_FILE"?result.configs.includes(value):
      match[1]==="METADATA_PATH"?result.metadata.includes(value):
      result.markers.length>0 && result.markers.length===value.split(",").length;
    if(!accepted)throw new Error("Alcance adicional rechazado: la ruta no es canónica, no es un proyecto concreto o incluye información protegida. "+line.slice(0,350));
    clean.push(normalized);
  }
  const declarations=[...new Set(clean)].join("\n");
  return {declarations,scope:buildCapabilityScope(root,declarations)};
}

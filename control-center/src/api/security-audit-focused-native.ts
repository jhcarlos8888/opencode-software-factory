import {createHash} from "node:crypto";
/** Validate native tool receipts without relying on the model's own claims. */
const obj=(v:unknown):Record<string,unknown>=>v&&typeof v==="object"&&!Array.isArray(v)?v as Record<string,unknown>:{};
const names=["list_files","read_file","search_text"] as const;
export function focusedClaudeTool(name:string):boolean {
  return names.some(n=>name==="mcp__factory_filesystem__"+n||name==="mcp__factory_filesystem_"+n);
}
export function focusedOpenCodeTool(name:string):boolean {
  return names.some(n=>name==="factory_filesystem_"+n);
}
export type FocusedNativeSourceCheck={file:string;line:number;lineSha256:string};
export function focusedLineSha256(line:string):string {
  return createHash("sha256").update(JSON.stringify(line)).digest("hex");
}
export type FocusedNativeReadMap=Map<string,Map<number,string>>;

export function focusedNativeReadLines(input:unknown,output:unknown,allowed:readonly string[]):FocusedNativeSourceCheck[]|null {
  const path=obj(input).path;
  if(typeof path!=="string"||!allowed.includes(path))return null;
  // SDK and OpenCode both wrap the MCP text result. Accept only known
  // successful structured read_file payloads, never prose or a request alone.
  const envelope=obj(output);
  if(envelope.isError===true||envelope.is_error===true)return null;
  const content=Array.isArray(output)?output:Array.isArray(envelope.content)?envelope.content:typeof output==="string"?[{type:"text",text:output}]:[];
  if(content.length!==1)return null;
  const item=obj(content[0]);
  if(item.type!=="text"||typeof item.text!=="string")return null;
  try{
    const data=obj(JSON.parse(item.text));
    if(data.path!==path||!Number.isSafeInteger(data.start_line)||Number(data.start_line)<1||
       !Number.isSafeInteger(data.returned_lines)||Number(data.returned_lines)<1||Number(data.returned_lines)>400||
       typeof data.content!=="string"||data.content.length===0||Buffer.byteLength(data.content)>128*1024)return null;
    const lines=data.content.split("\n");
    if(lines.length!==Number(data.returned_lines))return null;
    const parsed:FocusedNativeSourceCheck[]=[];
    for(let i=0;i<lines.length;i++){
      const numbered=/^ *(\d+) \| (.*)$/u.exec(lines[i]!);
      const n=Number(data.start_line)+i;
      if(!numbered||!Number.isSafeInteger(n)||Number(numbered[1])!==n)return null;
      parsed.push({file:path,line:n,lineSha256:focusedLineSha256(numbered[2]!)});
    }
    return parsed;
  }catch{}
  return null;
}
export function focusedReadReceipt(input:unknown,output:unknown,allowed:readonly string[]):string|null {
  return focusedNativeReadLines(input,output,allowed)?.[0]?.file??null;
}
/** Only parent-owned native successful read results can populate this map.
 * Never infer lines from assistant text or recover them from the current file. */
export function rememberFocusedNativeRead(read:FocusedNativeReadMap,lines:readonly FocusedNativeSourceCheck[]):void{
  for(const item of lines){
    const file=read.get(item.file)??new Map<number,string>();
    const prior=file.get(item.line);
    if(prior!==undefined&&prior!==item.lineSha256)throw Error("focused_native_source_changed");
    file.set(item.line,item.lineSha256);read.set(item.file,file);
  }
  if([...read.values()].reduce((total,lines)=>total+lines.size,0)>20000)throw Error("focused_native_read_limit");
}
/** Extract only references selected by the model from observed native reads.
 * Missing locations remain missing; the kernel rejects them. */
export function selectFocusedNativeSourceChecks(output:string,read:FocusedNativeReadMap):FocusedNativeSourceCheck[]{
  let parsed:Record<string,unknown>;
  try{parsed=obj(JSON.parse(output));}catch{throw Error("focused_malformed_output");}
  const record=obj(parsed.record);
  const refs=[...(Array.isArray(parsed.source_checks)?parsed.source_checks:[]),
    ...(Array.isArray(record.trace)?record.trace:[]),...(Array.isArray(record.evidence)?record.evidence:[])];
  if(refs.length>192)throw Error("focused_native_reference_limit");
  const selected=new Map<string,FocusedNativeSourceCheck>();
  for(const raw of refs){
    const loc=obj(raw);
    if(typeof loc.file!=="string"||typeof loc.line!=="number"||!Number.isSafeInteger(loc.line)||loc.line<1)continue;
    const lineSha256=read.get(loc.file)?.get(loc.line);
    if(lineSha256)selected.set(JSON.stringify([loc.file,loc.line]),{file:loc.file,line:loc.line,lineSha256});
  }
  if(selected.size>64)throw Error("focused_native_reference_limit");
  return [...selected.values()];
}
export function requireFocusedReadEvidence(output:string,read:ReadonlySet<string>,allowed:readonly string[]):void{
  let parsed:Record<string,unknown>;
  try{parsed=obj(JSON.parse(output));}catch{throw Error("focused_malformed_output");}
  if(read.size===0|| (parsed.decision==="fixed"&&!allowed.every(p=>read.has(p))))throw Error("focused_native_reads_missing");
}
export function validateFocusedOpenCodeEvidence(messages:unknown,allowed:readonly string[],output:string):FocusedNativeSourceCheck[]{
  const rows=Array.isArray(messages)?messages:obj(messages).data;
  if(!Array.isArray(rows))throw Error("focused_missing_native_messages");
  const read:FocusedNativeReadMap=new Map();
  for(const raw of rows){
    const m=obj(raw),info=obj(m.info);
    if(String(info.role??m.role??m.type)!=="assistant")continue;
    const parts=Array.isArray(m.parts)?m.parts:Array.isArray(m.content)?m.content:[];
    for(const rawPart of parts){
      const part=obj(rawPart);
      if(part.type!=="tool")continue;
      const name=String(part.tool??part.name??""),state=obj(part.state);
      if(!focusedOpenCodeTool(name))throw Error("focused_unexpected_native_tool");
      if(name==="factory_filesystem_read_file"&&state.status==="completed"){
        const lines=focusedNativeReadLines(state.input,state.content??state.output,allowed);
        if(lines)rememberFocusedNativeRead(read,lines);
      }
    }
  }
  requireFocusedReadEvidence(output,new Set(read.keys()),allowed);
  return selectFocusedNativeSourceChecks(output,read);
}

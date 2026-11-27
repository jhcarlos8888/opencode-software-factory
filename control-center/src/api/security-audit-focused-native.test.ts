import {test} from "node:test";
import assert from "node:assert/strict";
import {focusedClaudeTool,focusedOpenCodeTool,focusedReadReceipt,focusedNativeReadLines,focusedLineSha256,rememberFocusedNativeRead,requireFocusedReadEvidence,validateFocusedOpenCodeEvidence} from "./security-audit-focused-native.js";
import {buildOpenCodePermissionRules} from "./opencode-permissions.js";
const allowed=["src/a.ts","src/b.ts"];
const result=(path:string)=>[{type:"text",text:JSON.stringify({path,start_line:1,returned_lines:1,content:"1 | actual source"})}];
const tool=(path:string)=>({type:"tool",name:"factory_filesystem_read_file",state:{status:"completed",input:{path},content:result(path)}});
const messages=(...content:unknown[])=>({data:[{type:"assistant",content}]});
test("focused policies permit precisely three MCP tools and no skills or native operations",()=>{
  const rules=buildOpenCodePermissionRules("read-only",true,true);
  assert.deepEqual(rules.filter(r=>r.effect==="allow").map(r=>r.action),["factory_filesystem_list_files","factory_filesystem_read_file","factory_filesystem_search_text"]);
  assert.equal(rules[0]?.effect,"deny");
  assert.ok(rules.every(r=>r.effect!=="ask"));
  for(const name of ["Bash","Read","Skill","Agent","mcp__other__read_file","mcp__factory_filesystem__summarize_junit","mcp__factory_filesystem__read_file_extra"])assert.equal(focusedClaudeTool(name),false);
  assert.equal(focusedClaudeTool("mcp__factory_filesystem__read_file"),true);
  assert.equal(focusedOpenCodeTool("factory_filesystem_read_file"),true);
});
test("native read proof requires successful structured content for an allowed exact path",()=>{
  assert.equal(focusedReadReceipt({path:allowed[0]},result(allowed[0]!),allowed),allowed[0]);
  assert.equal(focusedReadReceipt({path:allowed[0]},{content:result(allowed[0]!),isError:true},allowed),null);
  assert.equal(focusedReadReceipt({path:allowed[0]},result(allowed[1]!),allowed),null);
  assert.equal(focusedReadReceipt({path:"outside"},result("outside"),allowed),null);
  assert.equal(focusedReadReceipt({path:allowed[0]},"I read the file",allowed),null);
  assert.throws(()=>requireFocusedReadEvidence('{"decision":"fixed"}',new Set([allowed[0]!]),allowed),/native_reads_missing/);
});
test("OpenCode verification checks real completed read parts and rejects forbidden tools",()=>{
  assert.doesNotThrow(()=>validateFocusedOpenCodeEvidence(messages(tool(allowed[0]!),tool(allowed[1]!)),allowed,'{"decision":"fixed"}'));
  assert.throws(()=>validateFocusedOpenCodeEvidence(messages(tool(allowed[0]!)),allowed,'{"decision":"fixed"}'),/native_reads_missing/);
  assert.throws(()=>validateFocusedOpenCodeEvidence(messages(tool(allowed[0]!),tool(allowed[1]!),{type:"tool",name:"shell",state:{status:"completed"}}),allowed,'{"decision":"fixed"}'),/unexpected_native_tool/);
  assert.throws(()=>validateFocusedOpenCodeEvidence(messages({type:"text",text:"I read both files"}),allowed,'{"decision":"fixed"}'),/native_reads_missing/);
  assert.throws(()=>validateFocusedOpenCodeEvidence(messages({...tool(allowed[0]!),state:{status:"error"}}),allowed,'{"decision":"needs_validation"}'),/native_reads_missing/);
});

test("native receipts select only referenced lines actually returned by the MCP",()=>{
  const path=allowed[0]!;
  const payload=[{type:"text",text:JSON.stringify({path,start_line:7,returned_lines:3,content:"    7 | function update() {\n    8 |   const doc = store.get(id);\n    9 |   guard(doc);"})}];
  const part={type:"tool",name:"factory_filesystem_read_file",state:{status:"completed",input:{path},content:payload}};
  const output=JSON.stringify({decision:"needs_validation",record:{trace:[{file:path,line:7},{file:path,line:8},{file:path,line:10}],evidence:[{file:path,line:8}]},source_checks:[{file:path,line:9,quote:"guard(doc)"}]});
  const checks=validateFocusedOpenCodeEvidence(messages(part),allowed,output);
  assert.deepEqual(checks.map(c=>c.line).sort((a,b)=>a-b),[7,8,9]);
  assert.equal(checks.find(c=>c.line===8)?.lineSha256,focusedLineSha256("  const doc = store.get(id);"));
  assert.equal(focusedNativeReadLines({path},[{type:"text",text:JSON.stringify({path,start_line:7,returned_lines:1,content:"    8 | incorrect numbering"})}],allowed),null);
  const read=new Map();
  rememberFocusedNativeRead(read,checks);
  assert.throws(()=>rememberFocusedNativeRead(read,[{file:path,line:8,lineSha256:"a".repeat(64)}]),/native_source_changed/);
});

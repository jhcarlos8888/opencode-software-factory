import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditInvocationUsage, claudeResultUsage, openCodeSessionUsage, storeClaudeAuditUsage } from "./security-audit-usage.js";
import type { SecurityAuditInvocationRow } from "./security-audit-persistence.js";

const at = Date.parse("2026-11-26T19:00:00Z");
const inv = {
  instanceId:"test-one",engine:"opencode",model:"opencode-go/glm",sessionId:"session-one",outcome:"succeeded",
  startedAt:new Date(at).toISOString(),finishedAt:new Date(at+10000).toISOString()
} as SecurityAuditInvocationRow;

function fixture(db:DatabaseSync) {
  db.exec("CREATE TABLE session_v2(id TEXT PRIMARY KEY,parent_id TEXT,model TEXT,time_created INTEGER,time_updated INTEGER,tokens_input INTEGER,tokens_output INTEGER,tokens_reasoning INTEGER,tokens_cache_read INTEGER,tokens_cache_write INTEGER); CREATE TABLE session_message(session_id TEXT,type TEXT,data TEXT)");
  db.prepare("INSERT INTO session_v2 VALUES (?,?,?,?,?,?,?,?,?,?)").run("session-one",null,JSON.stringify({id:"glm",providerID:"opencode-go"}),at+20,at+8000,123,45,0,50,0);
  db.prepare("INSERT INTO session_message VALUES (?,?,?)").run("session-one","assistant",JSON.stringify({tokens:{input:123,output:45},content:"not included in usage"}));
}

test("OpenCode metrics are session bound, typed, and distinguish unknown from zero",()=>{
  const db=new DatabaseSync(":memory:");
  try {
    fixture(db);
    assert.deepEqual(openCodeSessionUsage(db,inv),{source:"opencode-session",input:123,output:45,reasoning:0,cacheRead:50,cacheWrite:0,partial:false});
    assert.equal(openCodeSessionUsage(db,{...inv,model:"opencode-go/other"}),null);
    assert.equal(openCodeSessionUsage(db,{...inv,sessionId:"not-present"}),null);
    assert.equal(openCodeSessionUsage(db,{...inv,startedAt:new Date(at+60000).toISOString()}),null);
    assert.equal(openCodeSessionUsage(db,{...inv,outcome:"running",finishedAt:null})?.partial,true);
    db.exec("DELETE FROM session_message");
    assert.equal(openCodeSessionUsage(db,inv),null);
  }finally{db.close();}
});

test("usage projection opens local database read-only, rejects repeated session ids, and tolerates missing files",()=>{
  const dir=mkdtempSync(join(tmpdir(),"factory-usage-test-"));
  const path=join(dir,"opencode.db");
  const f=new DatabaseSync(":memory:");
  try{
    const d=new DatabaseSync(path);fixture(d);d.close();
    assert.equal(auditInvocationUsage(f,[inv],path).get(inv.instanceId)?.input,123);
    assert.equal(auditInvocationUsage(f,[inv,{...inv,instanceId:"another"}],path).size,0);
    assert.equal(auditInvocationUsage(f,[inv],join(dir,"missing.db")).size,0);
  }finally{f.close();rmSync(dir,{recursive:true,force:true});}
});

test("Claude accepts only official result metrics for an exact invocation and session",()=>{
  const d=new DatabaseSync(":memory:");
  try{
    d.exec("CREATE TABLE security_audit_invocations(instance_id TEXT PRIMARY KEY,session_id TEXT,engine TEXT); CREATE TABLE security_audit_usage(instance_id TEXT PRIMARY KEY,session_id TEXT,usage_json TEXT)");
    d.prepare("INSERT INTO security_audit_invocations VALUES (?,?,?)").run("test-one","session-one","claude");
    const c={...inv,engine:"claude",model:"deepseek"} as SecurityAuditInvocationRow;
    const event={type:"result",subtype:"success",usage:{input_tokens:40,output_tokens:9,cache_read_input_tokens:0,cache_creation_input_tokens:4}};
    assert.equal(claudeResultUsage({type:"assistant",usage:event.usage}),null);
    assert.equal(claudeResultUsage({type:"result",usage:{input_tokens:-1}}),null);
    storeClaudeAuditUsage(d,c.instanceId,"other-session",event);
    assert.equal(auditInvocationUsage(d,[c]).size,0);
    storeClaudeAuditUsage(d,c.instanceId,c.sessionId!,event);
    assert.deepEqual(auditInvocationUsage(d,[c]).get(c.instanceId),{source:"claude-sdk-result",input:40,output:9,reasoning:null,cacheRead:0,cacheWrite:4,partial:false});
    assert.equal(claudeResultUsage({...event,subtype:"error"})?.partial,true);
    assert.equal(auditInvocationUsage(d,[{...c,sessionId:"different"}]).size,0);
  }finally{d.close();}
});

import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {test} from "node:test";
import {initializeSecurityAuditSchema,createSecurityAuditRun,upsertSecurityAuditFinding,createSecurityAuditRemediation,transitionSecurityAuditRemediation,listSecurityAuditRemediations} from "./security-audit-persistence.js";
import {beginFocusedVerificationLedger,chargeFocusedVerificationAttempt,recordFocusedEngineResult,acceptFocusedVerificationReceipt,finishFocusedVerificationLedger,getFocusedVerificationLedger,recoverFocusedVerificationLedgers,publishFocusedVerification,storeFocusedClaudeUsage} from "./security-audit-focused-ledger.js";
import {runFocusedVerification,type FocusedVerificationRequest,type FocusedVerificationResult} from "./security-audit-focused-runner.js";
import {FOCUSED_REVALIDATION_BUDGET,type FocusedRevalidationPlan} from "./security-audit-focused-revalidation.js";
import {resolveSecurityAuditScopeFiles,snapshotSecurityAuditScope} from "./security-audit-scope.js";

const hash=(v:unknown)=>createHash("sha256").update(JSON.stringify(v)).digest("hex");
const fp="test-ownership",path="src/documents.js",line="if (doc.owner !== user) throw Error('Not found');";
const loc={kind:"sink",file:path,line:1,scope:"updateDocument",description:"Current ownership guard before write."};
const evidence={file:path,line:1,description:"The guard rejects a foreign document."};
const records=JSON.parse(readFileSync(new URL("./test-fixtures/security-audit/findings-valid.json",import.meta.url),"utf8"));
const original={...records[0],fingerprint:fp,trace:[loc],evidence:[evidence]};
const rejected={...records[2],fingerprint:fp,trace:[loc],evidence:[evidence],reason:"The current owner guard prevents the original unauthorized write."};
const runId="focused-execution",auditId="audit-original",remediationId="remediation-execution",finished="2026-11-27T12:00:00Z";
async function fixture(fn:(db:DatabaseSync,plan:FocusedRevalidationPlan)=>Promise<void>){
  const root=realpathSync(mkdtempSync(join(tmpdir(),"focused-ledger-test-")));
  const db=new DatabaseSync(join(root,"test.sqlite"));
  try{
    db.exec("CREATE TABLE execution_runs(id TEXT PRIMARY KEY,project_path TEXT,status TEXT,finished_at TEXT,configuration_snapshot_json TEXT); CREATE TABLE execution_agents(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES execution_runs(id),agent_id TEXT,engine TEXT,model_id TEXT,permission_profile TEXT,status TEXT,session_id TEXT);");
    initializeSecurityAuditSchema(db);initializeSecurityAuditSchema(db);
    mkdirSync(join(root,"src"));writeFileSync(join(root,path),line+"\n");
    const scope={kind:"component" as const,scopePaths:[path],domains:[]};
    const capture=await snapshotSecurityAuditScope(await resolveSecurityAuditScopeFiles(root,scope));
    const plan:FocusedRevalidationPlan={mode:"focused_revalidation",auditRunId:auditId,fingerprint:fp,remediationExecutionRunId:remediationId,
      remediationFinishedAt:finished,projectPath:root,scope,findingPath:path,originalRecordSha256:hash(original),originalFileSha256:"a".repeat(64),
      currentFileSha256:capture.files[0]!.sha256,currentSnapshotSha256:capture.sha256,budget:FOCUSED_REVALIDATION_BUDGET,
      verifiers:[{agentId:"reviewer",engine:"claude",modelId:"model-a"},{agentId:"build",engine:"opencode",modelId:"model-b"}],executionPolicy:"source-only",fullAudit:false};
    createSecurityAuditRun(db,{runId:auditId,projectPath:root,profile:"quick",intent:"full_audit",outputDir:join(root,"artifacts")});
    upsertSecurityAuditFinding(db,auditId,{fingerprint:fp,verdict:"confirmed",severity:"high",payload:original});
    db.prepare("INSERT INTO execution_runs VALUES(?,?,?,?,?)").run(remediationId,root,"succeeded",finished,null);
    createSecurityAuditRemediation(db,{runId:auditId,fingerprint:fp,executionRunId:remediationId});
    transitionSecurityAuditRemediation(db,auditId,fp,"in_progress");
    db.prepare("INSERT INTO execution_runs VALUES(?,?,?,?,?)").run(runId,root,"queued",null,JSON.stringify({focusedRevalidation:{planSha256:hash(plan)}}));
    await fn(db,plan);
  }finally{db.close();rmSync(root,{recursive:true,force:true});}
}
function result(db:DatabaseSync,r:FocusedVerificationRequest,n:number,sessionId="session-"+n):FocusedVerificationResult{
  const res:FocusedVerificationResult={instanceId:r.instanceId,agentRunId:r.instanceId,handoffId:"handoff-"+n,sessionId,verifier:r.verifier,status:"succeeded",
    output:JSON.stringify({fingerprint:fp,decision:"fixed",record:rejected,source_checks:[{file:path,line:1,quote:line}]}),nativeSourceChecks:[{file:path,line:1,lineSha256:hash(line)}]};
  db.prepare("INSERT INTO execution_agents VALUES(?,?,?,?,?,?,?,?)").run(r.instanceId,runId,r.verifier.agentId,r.verifier.engine,r.verifier.modelId,"read-only","succeeded",sessionId);
  return res;
}
test("focused ledger persists actual charged attempts and kernel receipts without marking remediation verified_fixed",async()=>{
  await fixture(async(db,plan)=>{
    beginFocusedVerificationLedger(db,runId,plan);
    db.prepare("UPDATE execution_runs SET status='running' WHERE id=?").run(runId);
    let n=0,last:FocusedVerificationRequest|undefined;
    const outcome=await runFocusedVerification({plan,originalRecord:original,
      invoke:async r=>{
        chargeFocusedVerificationAttempt(db,runId,r);last=r;
        assert.equal(getFocusedVerificationLedger(db,runId).attempts.at(-1)?.status,"charged");
        const res=result(db,r,++n);
        recordFocusedEngineResult(db,runId,res);return res;
      },onReceipt:r=>acceptFocusedVerificationReceipt(db,runId,r)});
    assert.equal(outcome.status,"evidence_ready",JSON.stringify(outcome));assert.equal(outcome.attempted,2);
    assert.throws(()=>chargeFocusedVerificationAttempt(db,runId,{...last!,instanceId:"third"}),/budget/);
    assert.throws(()=>finishFocusedVerificationLedger(db,runId,{...outcome,receipts:[]}),/outcome_mismatch/);
    finishFocusedVerificationLedger(db,runId,outcome);
    const saved=getFocusedVerificationLedger(db,runId);
    assert.equal(saved.status,"evidence_ready");assert.deepEqual(saved.attempts.map(a=>a.receipt),outcome.receipts);
    assert.equal(listSecurityAuditRemediations(db,auditId)[0]?.state,"in_progress");
    assert.equal(listSecurityAuditRemediations(db,auditId)[0]?.evidence.length,0);
    assert.throws(()=>finishFocusedVerificationLedger(db,runId,outcome),/terminal/);
    initializeSecurityAuditSchema(db);assert.deepEqual(getFocusedVerificationLedger(db,runId),saved);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(),[]);
  });
});
test("ledger rejects stale plan, concurrent runs, fabricated success and mismatched native agent identities",async()=>{
  await fixture(async(db,plan)=>{
    assert.throws(()=>beginFocusedVerificationLedger(db,runId,{...plan,currentSnapshotSha256:"b".repeat(64)}),/plan_mismatch/);
    beginFocusedVerificationLedger(db,runId,plan);
    db.prepare("INSERT INTO execution_runs VALUES(?,?,?,?,?)").run("other-execution",plan.projectPath,"queued",null,JSON.stringify({focusedRevalidation:{planSha256:hash(plan)}}));
    assert.throws(()=>beginFocusedVerificationLedger(db,"other-execution",plan),/UNIQUE/);
    assert.throws(()=>finishFocusedVerificationLedger(db,runId,{status:"evidence_ready",reason:null,attempted:0,receipts:[]}),/no_consensus/);
    const outcome=await runFocusedVerification({plan,originalRecord:original,invoke:async r=>{
      assert.throws(()=>chargeFocusedVerificationAttempt(db,runId,{...r,allowedPaths:["elsewhere"]}),/request_mismatch/);
      chargeFocusedVerificationAttempt(db,runId,r);
      const res=result(db,r,1);
      assert.throws(()=>recordFocusedEngineResult(db,runId,{...res,sessionId:"fake-session"}),/agent_receipt_mismatch/);
      assert.throws(()=>chargeFocusedVerificationAttempt(db,runId,{...r,instanceId:"premature",verifier:plan.verifiers[1]}),/budget_or_previous/);
      recordFocusedEngineResult(db,runId,res);
      return {...res,output:res.output+" invalid"};
    },onReceipt:r=>acceptFocusedVerificationReceipt(db,runId,r)});
    assert.equal(outcome.status,"incomplete");assert.equal(outcome.attempted,1);assert.equal(outcome.receipts.length,0);
    finishFocusedVerificationLedger(db,runId,outcome);
    assert.equal(getFocusedVerificationLedger(db,runId).status,"incomplete");
    assert.equal(getFocusedVerificationLedger(db,runId).attempts[0]?.receipt,null);
    assert.equal(listSecurityAuditRemediations(db,auditId)[0]?.state,"in_progress");
  });
});
test("ledger refuses reused engine sessions and tampered output receipts, preserves charged interruptions",async()=>{
  await fixture(async(db,plan)=>{
    beginFocusedVerificationLedger(db,runId,plan);
    db.prepare("INSERT INTO execution_agents VALUES(?,?,?,?,?,?,?,?)").run("old-agent",remediationId,"reviewer","claude","model-a","read-only","succeeded","old-session");
    const outcome=await runFocusedVerification({plan,originalRecord:original,invoke:async r=>{
      chargeFocusedVerificationAttempt(db,runId,r);
      recordFocusedEngineResult(db,runId,result(db,r,1,"old-session"));
      throw Error("unexpected");
    },onReceipt:r=>acceptFocusedVerificationReceipt(db,runId,r)});
    assert.equal(outcome.reason,"focused_session_reused");
    finishFocusedVerificationLedger(db,runId,outcome);
    assert.equal(getFocusedVerificationLedger(db,runId).attempts[0]?.status,"interrupted");
    assert.equal(listSecurityAuditRemediations(db,auditId)[0]?.state,"in_progress");
  });
});
test("ledger rejects a receipt whose output hash differs from the actual engine result",async()=>{
  await fixture(async(db,plan)=>{
    beginFocusedVerificationLedger(db,runId,plan);
    const outcome=await runFocusedVerification({plan,originalRecord:original,invoke:async r=>{
      chargeFocusedVerificationAttempt(db,runId,r);const res=result(db,r,1);recordFocusedEngineResult(db,runId,res);return res;
    },onReceipt:r=>{
      assert.throws(()=>acceptFocusedVerificationReceipt(db,runId,{...r,outputSha256:"b".repeat(64)}),/invalid_receipt/);
      throw Error("receipt_storage_rejected");
    }});
    assert.equal(outcome.reason,"receipt_storage_rejected");assert.equal(outcome.receipts.length,0);
    finishFocusedVerificationLedger(db,runId,outcome);
    assert.equal(getFocusedVerificationLedger(db,runId).attempts[0]?.receipt,null);
  });
});

test("a failed charge does not consume a model call or create a fake receipt",async()=>{
  await fixture(async(db,plan)=>{
    beginFocusedVerificationLedger(db,runId,plan);
    const outcome=await runFocusedVerification({plan,originalRecord:original,onCharge:r=>{
      chargeFocusedVerificationAttempt(db,runId,{...r,allowedPaths:["unapproved"]});
    },invoke:async()=>{throw Error("must_not_invoke");}});
    assert.equal(outcome.attempted,0);assert.equal(outcome.reason,"focused_request_mismatch");
    finishFocusedVerificationLedger(db,runId,outcome);
    assert.equal(getFocusedVerificationLedger(db,runId).attempts.length,0);
  });
});
test("restart reconciles interrupted focused attempts without replay or changing remediation",async()=>{
  await fixture(async(db,plan)=>{
    beginFocusedVerificationLedger(db,runId,plan);
    let request:FocusedVerificationRequest|undefined;
    const outcome=await runFocusedVerification({plan,originalRecord:original,onCharge:r=>{chargeFocusedVerificationAttempt(db,runId,r);request=r;},
      invoke:async()=>{throw Error("simulated_process_loss");}});
    assert.equal(outcome.attempted,1);
    assert.ok(request);
    assert.equal(recoverFocusedVerificationLedgers(db),0);
    db.prepare("UPDATE execution_runs SET status='interrupted' WHERE id=?").run(runId);
    assert.equal(recoverFocusedVerificationLedgers(db),1);
    const ledger=getFocusedVerificationLedger(db,runId);
    assert.equal(ledger.status,"incomplete");assert.equal(ledger.reason,"execution_interrupted");assert.equal(ledger.attempts[0]?.status,"interrupted");assert.equal(ledger.attempts[0]?.receipt,null);
    assert.equal(recoverFocusedVerificationLedgers(db),0);
    assert.equal(listSecurityAuditRemediations(db,auditId)[0]?.state,"in_progress");
  });
});

test("only a terminal two-engine consensus on the fresh plan can certify a remediation",async()=>{
  await fixture(async(db,plan)=>{
    beginFocusedVerificationLedger(db,runId,plan);
    let n=0;
    const outcome=await runFocusedVerification({plan,originalRecord:original,onCharge:r=>chargeFocusedVerificationAttempt(db,runId,r),
      invoke:async r=>{const res=result(db,r,++n);recordFocusedEngineResult(db,runId,res);return res;},
      onReceipt:r=>acceptFocusedVerificationReceipt(db,runId,r)});
    assert.equal(outcome.status,"evidence_ready",JSON.stringify(outcome));
    finishFocusedVerificationLedger(db,runId,outcome);
    db.exec("ALTER TABLE execution_runs ADD COLUMN started_at TEXT");
    db.prepare("UPDATE execution_runs SET started_at=?,finished_at=? WHERE id=?").run("2026-11-27T12:01:00Z","2099-01-01T00:00:00Z",runId);
    assert.throws(()=>publishFocusedVerification(db,runId,plan),/execution_mismatch/);
    db.prepare("UPDATE execution_runs SET status='succeeded' WHERE id=?").run(runId);
    assert.throws(()=>publishFocusedVerification(db,runId,{...plan,currentSnapshotSha256:"b".repeat(64)}),/closure_stale/);
    const first=outcome.receipts[0]!;
    db.prepare("UPDATE execution_agents SET session_id='fake' WHERE id=?").run(first.agentRunId);
    assert.throws(()=>publishFocusedVerification(db,runId,plan),/agent_receipt_mismatch/);
    db.prepare("UPDATE execution_agents SET session_id=? WHERE id=?").run(first.sessionId,first.agentRunId);
    assert.equal(listSecurityAuditRemediations(db,auditId)[0]?.state,"in_progress");
    const native=db.prepare("SELECT native_evidence_json FROM security_audit_focused_attempts WHERE instance_id=?").get(first.instanceId)?.native_evidence_json as string;
    db.prepare("UPDATE security_audit_focused_attempts SET native_evidence_json='[]' WHERE instance_id=?").run(first.instanceId);
    assert.throws(()=>publishFocusedVerification(db,runId,plan),/native_evidence_integrity/);
    db.prepare("UPDATE security_audit_focused_attempts SET native_evidence_json=? WHERE instance_id=?").run(native,first.instanceId);
    publishFocusedVerification(db,runId,plan);
    const rem=listSecurityAuditRemediations(db,auditId)[0]!;
    assert.equal(rem.state,"verified_fixed");assert.equal(rem.evidence.length,1);
    assert.equal((rem.evidence[0] as {fullAudit:boolean}).fullAudit,false);
    assert.equal(db.prepare("SELECT verdict FROM security_audit_findings WHERE run_id=? AND fingerprint=?").get(auditId,fp)?.verdict,"confirmed");
    assert.throws(()=>publishFocusedVerification(db,runId,plan),/remediation_changed/);
    assert.equal(listSecurityAuditRemediations(db,auditId)[0]?.evidence.length,1);
  });
});

test("focused counters bind Claude SDK results to native identities, including partial cancellation",async()=>{
  await fixture(async(db,plan)=>{
    beginFocusedVerificationLedger(db,runId,plan);
    const ctrl=new AbortController();
    const outcome=await runFocusedVerification({plan,originalRecord:original,signal:ctrl.signal,onCharge:r=>chargeFocusedVerificationAttempt(db,runId,r),invoke:async r=>{
      const res=result(db,r,1);
      const event={type:"result",subtype:"success",usage:{input_tokens:42,output_tokens:7,cache_read_input_tokens:11,cache_creation_input_tokens:0}};
      storeFocusedClaudeUsage(db,runId,r.instanceId,"wrong-session",event);
      assert.equal(getFocusedVerificationLedger(db,runId).attempts[0]?.usage,null);
      storeFocusedClaudeUsage(db,runId,r.instanceId,res.sessionId!,event);
      assert.deepEqual(getFocusedVerificationLedger(db,runId).attempts[0]?.usage,{source:"claude-sdk-result",input:42,output:7,reasoning:null,cacheRead:11,cacheWrite:0,partial:true});
      ctrl.abort();
      return res;
    }});
    assert.equal(outcome.status,"cancelled");
    assert.equal(outcome.attempted,1);
    finishFocusedVerificationLedger(db,runId,outcome);
    const saved=getFocusedVerificationLedger(db,runId);
    assert.equal(saved.attempts[0]?.usage?.input,42);
    assert.equal(saved.attempts[0]?.usage?.partial,true);
    assert.equal(saved.attempts[0]?.receipt,null);
    assert.equal(listSecurityAuditRemediations(db,auditId)[0]?.state,"in_progress");
    db.prepare("UPDATE execution_agents SET session_id='changed' WHERE id=?").run(saved.attempts[0]!.instanceId);
    assert.equal(getFocusedVerificationLedger(db,runId).attempts[0]?.usage,null);
  });
});
test("focused OpenCode metrics use exact model and native session, never invent historical Claude counters",async()=>{
  await fixture(async(db,plan)=>{
    plan={...plan,verifiers:[plan.verifiers[0],{...plan.verifiers[1],modelId:"opencode-go/model-b"}]};
    db.prepare("UPDATE execution_runs SET configuration_snapshot_json=? WHERE id=?").run(JSON.stringify({focusedRevalidation:{planSha256:hash(plan)}}),runId);
    beginFocusedVerificationLedger(db,runId,plan);
    const localPath=join(plan.projectPath,"opencode-metrics.sqlite");
    const local=new DatabaseSync(localPath);
    try{
      local.exec("CREATE TABLE session_v2(id TEXT PRIMARY KEY,parent_id TEXT,model TEXT,time_created INTEGER,time_updated INTEGER,tokens_input INTEGER,tokens_output INTEGER,tokens_reasoning INTEGER,tokens_cache_read INTEGER,tokens_cache_write INTEGER); CREATE TABLE session_message(session_id TEXT,type TEXT,data TEXT)");
      let n=0;
      const outcome=await runFocusedVerification({plan,originalRecord:original,onCharge:r=>chargeFocusedVerificationAttempt(db,runId,r),invoke:async r=>{
        const res=result(db,r,++n);
        if(n===2){
          const at=Date.now();
          local.prepare("INSERT INTO session_v2 VALUES (?,?,?,?,?,?,?,?,?,?)").run(res.sessionId,null,JSON.stringify({id:"model-b",providerID:"opencode-go"}),at,at,123,45,0,60,0);
          local.prepare("INSERT INTO session_message VALUES (?,?,?)").run(res.sessionId,"assistant",JSON.stringify({tokens:{input:123}}));
        }
        recordFocusedEngineResult(db,runId,res);return res;
      },onReceipt:r=>acceptFocusedVerificationReceipt(db,runId,r)});
      assert.equal(outcome.status,"evidence_ready",JSON.stringify(outcome));
      finishFocusedVerificationLedger(db,runId,outcome);
      const saved=getFocusedVerificationLedger(db,runId,localPath);
      assert.equal(saved.attempts[0]?.usage,null);
      assert.deepEqual(saved.attempts[1]?.usage,{source:"opencode-session",input:123,output:45,reasoning:0,cacheRead:60,cacheWrite:0,partial:false});
      local.prepare("UPDATE session_v2 SET model=?").run(JSON.stringify({id:"other",providerID:"opencode-go"}));
      assert.equal(getFocusedVerificationLedger(db,runId,localPath).attempts[1]?.usage,null);
      assert.equal(getFocusedVerificationLedger(db,runId,localPath).status,"evidence_ready");
    }finally{local.close();}
  });
});

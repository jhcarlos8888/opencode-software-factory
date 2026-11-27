import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync,mkdirSync,realpathSync,rmSync,writeFileSync,readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runFocusedVerification,type FocusedVerificationRequest,type FocusedVerificationResult } from "./security-audit-focused-runner.js";
import { FOCUSED_REVALIDATION_BUDGET,type FocusedRevalidationPlan } from "./security-audit-focused-revalidation.js";
import { resolveSecurityAuditScopeFiles,snapshotSecurityAuditScope } from "./security-audit-scope.js";

const fp="focused-finding";
const file="src/documents.js";
const line="if (doc.owner !== user) throw Error('Not found');";
const loc={kind:"sink",file,line:1,scope:"updateDocument",description:"The ownership guard precedes the write."};
const evidence={file,line:1,description:"The ownership guard rejects foreign documents."};
const fixtures=JSON.parse(readFileSync(new URL("./test-fixtures/security-audit/findings-valid.json",import.meta.url),"utf8"));
const original={...fixtures[0],fingerprint:fp,trace:[loc],evidence:[evidence]};
const rejected={...fixtures[2],fingerprint:fp,trace:[loc],evidence:[evidence],reason:"The current owner guard rejects the unauthorized operation."};
const blocked={...fixtures[1],fingerprint:fp,trace:[loc],evidence:[evidence]};
const hash=(x:unknown)=>createHash("sha256").update(JSON.stringify(x)).digest("hex");

async function fixture(fn:(plan:FocusedRevalidationPlan,root:string)=>Promise<void>){
  const root=realpathSync(mkdtempSync(join(tmpdir(),"focused-runner-test-")));
  try {
    mkdirSync(join(root,"src"));writeFileSync(join(root,file),line+"\n");
    const scope={kind:"component" as const,scopePaths:[file],domains:[]};
    const snapshot=await snapshotSecurityAuditScope(await resolveSecurityAuditScopeFiles(root,scope));
    const plan:FocusedRevalidationPlan={mode:"focused_revalidation",auditRunId:"audit-test",fingerprint:fp,
      remediationExecutionRunId:"remediation-test",remediationFinishedAt:"2026-11-27T12:00:00Z",
      projectPath:root,scope,findingPath:file,originalRecordSha256:hash(original),
      originalFileSha256:"a".repeat(64),currentFileSha256:snapshot.files[0]!.sha256,currentSnapshotSha256:snapshot.sha256,
      budget:FOCUSED_REVALIDATION_BUDGET,verifiers:[{agentId:"reviewer",engine:"claude",modelId:"model-a"},{agentId:"build",engine:"opencode",modelId:"model-b"}],
      executionPolicy:"source-only",fullAudit:false};
    await fn(plan,root);
  }finally{rmSync(root,{recursive:true,force:true});}
}
function fake(r:FocusedVerificationRequest,n:number,decision="fixed",overrides:Record<string,unknown>={}):FocusedVerificationResult {
  return {instanceId:r.instanceId,agentRunId:"agent-"+n,handoffId:"handoff-"+n,sessionId:"session-"+n,verifier:r.verifier,status:"succeeded",
    output:JSON.stringify({fingerprint:fp,decision,record:decision==="fixed"?rejected:decision==="still_present"?original:blocked,
      source_checks:[{file,line:1,quote:line}],...overrides})};
}

test("focused runner validates two independent official records and exact current source quotes without changing the project",async()=>{
  await fixture(async(plan,root)=>{
    const requests:FocusedVerificationRequest[]=[];
    const outcome=await runFocusedVerification({plan,originalRecord:original,invoke:async r=>{
      requests.push(r);return fake(r,requests.length);
    }});
    assert.equal(outcome.status,"evidence_ready",JSON.stringify(outcome));
    assert.equal(outcome.attempted,2);assert.equal(outcome.receipts.length,2);
    assert.deepEqual(requests.map(r=>r.verifier.engine),["claude","opencode"]);
    assert.equal(requests[0]!.prompt,requests[1]!.prompt);
    assert.ok(requests.every(r=>r.permissionProfile==="read-only"&&r.executionPolicy==="source-only"&&r.allowedPaths.length===1));
    assert.ok(outcome.receipts.every(r=>r.officialValidator==="PASS"&&r.recordSha256===hash(rejected)&&r.snapshotSha256===plan.currentSnapshotSha256));
    assert.notEqual(outcome.receipts[0]!.sessionId,outcome.receipts[1]!.sessionId);
    assert.equal(readFileSync(join(root,file),"utf8"),line+"\n");
  });
});
test("two engines reporting the vulnerability remains never certify a fix; disagreement is incomplete",async()=>{
  await fixture(async plan=>{
    let n=0;
    const present=await runFocusedVerification({plan,originalRecord:original,invoke:async r=>fake(r,++n,"still_present")});
    assert.equal(present.status,"still_present",JSON.stringify(present));
    n=0;
    const mixed=await runFocusedVerification({plan,originalRecord:original,invoke:async r=>fake(r,++n,n===1?"fixed":"needs_validation")});
    assert.equal(mixed.status,"incomplete");assert.equal(mixed.reason,"verifiers_disagree_or_need_validation");
  });
});
test("invalid official records, fingerprints and fabricated quotes fail closed without retry",async()=>{
  await fixture(async plan=>{
    for (const [overrides,reason] of [
      [{fingerprint:"another"},"invalid_output_contract"],
      [{record:{...rejected,fingerprint:"another"}},"verdict_mismatch"],
      [{record:{...rejected,reason:undefined}},"official_record_invalid"],
      [{source_checks:[{file,line:1,quote:"a fabricated code line"}]},"source_quote_mismatch"],
      [{source_checks:[{file:"../outside",line:1,quote:line}]},"source_quote_mismatch"],
      [{record:{...rejected,trace:[{...loc,line:2}]}},"record_location_not_checked"],
      [{source_checks:[]},"source_checks_missing"],
    ] as const){
      const result=await runFocusedVerification({plan,originalRecord:original,invoke:async r=>fake(r,1,"fixed",overrides)});
      assert.equal(result.status,"incomplete");assert.equal(result.reason,reason,JSON.stringify(result));assert.equal(result.attempted,1);
    }
  });
});
test("reused session or handoff identities and engine mismatch cannot certify",async()=>{
  await fixture(async plan=>{
    for(const change of ["sessionId","handoffId","agentRunId"] as const){
      let n=0;
      const outcome=await runFocusedVerification({plan,originalRecord:original,invoke:async r=>{
        const result=fake(r,++n);return {...result,[change]:"reused"};
      }});
      assert.equal(outcome.status,"incomplete");assert.equal(outcome.reason,"verifier_identity_reused");assert.equal(outcome.attempted,2);
    }
    const wrong=await runFocusedVerification({plan,originalRecord:original,invoke:async r=>({...fake(r,1),verifier:plan.verifiers[1]})});
    assert.equal(wrong.reason,"missing_or_mismatched_receipt");
  });
});
test("source changes during invocation, stale plans and altered original record stop verification",async()=>{
  await fixture(async(plan,root)=>{
    const changed=await runFocusedVerification({plan,originalRecord:original,invoke:async r=>{
      writeFileSync(join(root,file),"different source\n");return fake(r,1);
    }});
    assert.equal(changed.status,"incomplete");assert.equal(changed.reason,"source_changed");assert.equal(changed.attempted,1);
    const stale=await runFocusedVerification({plan,originalRecord:original,invoke:async()=>{throw Error("unexpected");}});
    assert.equal(stale.attempted,0);assert.equal(stale.reason,"source_changed");
    const altered=await runFocusedVerification({plan,originalRecord:{...original,title:"different"},invoke:async()=>{throw Error("unexpected");}});
    assert.equal(altered.attempted,0);assert.equal(altered.reason,"original_record_mismatch");
  });
});
test("cancellation and provider failure never replay or publish evidence_ready",async()=>{
  await fixture(async plan=>{
    const ctrl=new AbortController();
    const cancelled=await runFocusedVerification({plan,originalRecord:original,signal:ctrl.signal,invoke:async r=>{ctrl.abort();assert.equal(r.signal.aborted,true);return fake(r,1);}});
    assert.equal(cancelled.status,"cancelled");assert.equal(cancelled.attempted,1);
    const before=await runFocusedVerification({plan,originalRecord:original,signal:ctrl.signal,invoke:async()=>{throw Error("unexpected");}});
    assert.equal(before.attempted,0);assert.equal(before.status,"cancelled");
    const failed=await runFocusedVerification({plan,originalRecord:original,invoke:async r=>({...fake(r,1),status:"failed"})});
    assert.equal(failed.reason,"invocation_not_succeeded");assert.equal(failed.attempted,1);
  });
});
test("bad budget, same engine and non-JSON answers cannot launch extra calls",async()=>{
  await fixture(async plan=>{
    for(const bad of [{...plan,budget:{...plan.budget,maxInvocations:3}},{...plan,verifiers:[plan.verifiers[0],{...plan.verifiers[1],engine:"claude"}]}] as unknown as FocusedRevalidationPlan[]){
      const result=await runFocusedVerification({plan:bad,originalRecord:original,invoke:async()=>{throw Error("unexpected");}});
      assert.equal(result.attempted,0);assert.equal(result.reason,"invalid_plan");
    }
    const falseHash=await runFocusedVerification({plan:{...plan,currentFileSha256:"b".repeat(64)},originalRecord:original,invoke:async()=>{throw Error("unexpected");}});
    assert.equal(falseHash.attempted,0);assert.equal(falseHash.reason,"source_changed");
    const malformed=await runFocusedVerification({plan,originalRecord:original,invoke:async r=>({...fake(r,1),output:"Here is JSON: "+fake(r,1).output})});
    assert.equal(malformed.reason,"malformed_output");assert.equal(malformed.attempted,1);
  });
});

test("fixed evidence cannot omit a file from the historical scope or omit real session identity",async()=>{
  await fixture(async(plan,root)=>{
    const missing=await runFocusedVerification({plan,originalRecord:original,invoke:async r=>({...fake(r,1),sessionId:null})});
    assert.equal(missing.reason,"missing_or_mismatched_receipt");
    const other="src/store.js";
    writeFileSync(join(root,other),"const persisted = new Map();\n");
    const extended={...original,evidence:[evidence,{file:other,line:1,description:"storage"}]};
    const scope={...plan.scope,scopePaths:[file,other]};
    const current=await snapshotSecurityAuditScope(await resolveSecurityAuditScopeFiles(root,scope));
    const outcome=await runFocusedVerification({plan:{...plan,scope,originalRecordSha256:hash(extended),currentSnapshotSha256:current.sha256},originalRecord:extended,invoke:async r=>fake(r,1)});
    assert.equal(outcome.status,"incomplete");assert.equal(outcome.reason,"focused_scope_not_checked");
    assert.equal(outcome.attempted,1);
  });
});

/** Internal durable evidence ledger. Separate from full audit and remediation
 * closure. No public write API and no verified_fixed transition here. */
import {createHash} from "node:crypto";
import type {DatabaseSync} from "node:sqlite";
import type {FocusedRevalidationPlan} from "./security-audit-focused-revalidation.js";
import type {FocusedVerificationRequest,FocusedVerificationResult,FocusedVerificationReceipt,FocusedVerificationOutcome} from "./security-audit-focused-runner.js";
const digest=(s:string)=>createHash("sha256").update(s).digest("hex");
const hash=(v:unknown)=>digest(JSON.stringify(v));
const id=(v:unknown):v is string=>typeof v==="string"&&/^[A-Za-z0-9_-]{1,160}$/.test(v);
const hex=(v:unknown):v is string=>typeof v==="string"&&/^[a-f0-9]{64}$/.test(v);
const now=()=>new Date().toISOString();
function require(value:unknown,reason:string):asserts value {if(!value)throw Error(reason);}
function tx<T>(db:DatabaseSync,fn:()=>T):T {
  db.exec("BEGIN IMMEDIATE");
  try {const result=fn();db.exec("COMMIT");return result;}catch(e){db.exec("ROLLBACK");throw e;}
}
export function initializeFocusedVerificationSchema(db:DatabaseSync):void {
  db.exec([
    "CREATE TABLE IF NOT EXISTS security_audit_focused_runs (",
    "execution_run_id TEXT PRIMARY KEY REFERENCES execution_runs(id) ON DELETE CASCADE,",
    "audit_run_id TEXT NOT NULL, fingerprint TEXT NOT NULL, project_path TEXT NOT NULL,",
    "remediation_execution_id TEXT NOT NULL REFERENCES execution_runs(id),",
    "plan_json TEXT NOT NULL, plan_sha256 TEXT NOT NULL,",
    "status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','evidence_ready','still_present','incomplete','cancelled')),",
    "reason TEXT, created_at TEXT NOT NULL, finished_at TEXT,",
    "FOREIGN KEY(audit_run_id,fingerprint) REFERENCES security_audit_remediations(run_id,fingerprint) ON DELETE CASCADE,",
    "CHECK((status='running' AND finished_at IS NULL) OR (status<>'running' AND finished_at IS NOT NULL)));",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_focused_active_project ON security_audit_focused_runs(project_path) WHERE status='running';",
    "CREATE TABLE IF NOT EXISTS security_audit_focused_attempts (",
    "instance_id TEXT PRIMARY KEY, execution_run_id TEXT NOT NULL REFERENCES security_audit_focused_runs(execution_run_id) ON DELETE CASCADE,",
    "ordinal INTEGER NOT NULL CHECK(ordinal IN (1,2)), agent_id TEXT NOT NULL,",
    "engine TEXT NOT NULL CHECK(engine IN ('claude','opencode')), model_id TEXT NOT NULL,",
    "status TEXT NOT NULL DEFAULT 'charged' CHECK(status IN ('charged','succeeded','failed','cancelled','interrupted')),",
    "agent_run_id TEXT, handoff_id TEXT, session_id TEXT, output_sha256 TEXT, receipt_json TEXT, receipt_sha256 TEXT,",
    "started_at TEXT NOT NULL, finished_at TEXT, UNIQUE(execution_run_id,ordinal), UNIQUE(engine,session_id),",
    "CHECK((receipt_json IS NULL AND receipt_sha256 IS NULL) OR (status='succeeded' AND receipt_json IS NOT NULL AND receipt_sha256 IS NOT NULL)),",
    "CHECK((status='charged' AND finished_at IS NULL) OR (status<>'charged' AND finished_at IS NOT NULL)));"
  ].join(" "));
}
type RunRow={execution_run_id:string;audit_run_id:string;fingerprint:string;project_path:string;remediation_execution_id:string;plan_json:string;plan_sha256:string;status:string;reason:string|null;created_at:string;finished_at:string|null};
type AttemptRow={instance_id:string;execution_run_id:string;ordinal:number;agent_id:string;engine:string;model_id:string;status:string;agent_run_id:string|null;handoff_id:string|null;session_id:string|null;output_sha256:string|null;receipt_json:string|null;receipt_sha256:string|null;started_at:string;finished_at:string|null};
function getRun(db:DatabaseSync,runId:string):RunRow{
  const row=db.prepare("SELECT * FROM security_audit_focused_runs WHERE execution_run_id=?").get(runId) as RunRow|undefined;
  require(row,"focused_run_missing");return row;
}
function getPlan(row:RunRow):FocusedRevalidationPlan{
  require(digest(row.plan_json)===row.plan_sha256,"focused_plan_integrity");
  return JSON.parse(row.plan_json) as FocusedRevalidationPlan;
}
function attempts(db:DatabaseSync,runId:string):AttemptRow[]{
  return db.prepare("SELECT * FROM security_audit_focused_attempts WHERE execution_run_id=? ORDER BY ordinal").all(runId) as AttemptRow[];
}
function active(db:DatabaseSync,runId:string):FocusedRevalidationPlan{
  const row=getRun(db,runId);require(row.status==="running","focused_run_terminal");
  const e=db.prepare("SELECT project_path,status FROM execution_runs WHERE id=?").get(runId);
  require(e?.project_path===row.project_path&&["queued","running","waiting"].includes(String(e.status)),"focused_execution_not_active");
  const original=db.prepare("SELECT state,execution_run_id FROM security_audit_remediations WHERE run_id=? AND fingerprint=?").get(row.audit_run_id,row.fingerprint);
  require(original?.state==="in_progress"&&original.execution_run_id===row.remediation_execution_id,"focused_remediation_changed");
  const plan=getPlan(row);
  const finding=db.prepare("SELECT verdict,payload_json FROM security_audit_findings WHERE run_id=? AND fingerprint=?").get(row.audit_run_id,row.fingerprint);
  require(finding?.verdict==="confirmed"&&typeof finding.payload_json==="string"&&hash(JSON.parse(finding.payload_json))===plan.originalRecordSha256,"focused_original_changed");
  return plan;
}
function readReceipt(row:AttemptRow):FocusedVerificationReceipt|null{
  if(row.receipt_json===null)return null;
  require(digest(row.receipt_json)===row.receipt_sha256,"focused_receipt_integrity");
  return JSON.parse(row.receipt_json) as FocusedVerificationReceipt;
}
/** Caller must recompute admission and create the linked queued execution. */
export function beginFocusedVerificationLedger(db:DatabaseSync,runId:string,plan:FocusedRevalidationPlan):void{
  tx(db,()=>{
    require(id(runId)&&plan.mode==="focused_revalidation"&&plan.fullAudit===false&&plan.executionPolicy==="source-only"&&
      plan.budget.maxInvocations===2&&plan.budget.maxConcurrency===1&&plan.budget.maxDurationMs===600000&&
      plan.verifiers.length===2&&plan.verifiers[0].agentId==="reviewer"&&plan.verifiers[1].agentId==="build"&&
      plan.verifiers[0].engine!==plan.verifiers[1].engine&&plan.verifiers.every(v=>["claude","opencode"].includes(v.engine))&&
      hex(plan.originalRecordSha256)&&hex(plan.currentSnapshotSha256),"focused_invalid_plan");
    const e=db.prepare("SELECT project_path,status,configuration_snapshot_json FROM execution_runs WHERE id=?").get(runId);
    require(e?.project_path===plan.projectPath&&e.status==="queued"&&typeof e.configuration_snapshot_json==="string","focused_execution_not_queued");
    require(JSON.parse(e.configuration_snapshot_json).focusedRevalidation?.planSha256===hash(plan),"focused_execution_plan_mismatch");
    const original=db.prepare("SELECT state,execution_run_id FROM security_audit_remediations WHERE run_id=? AND fingerprint=?").get(plan.auditRunId,plan.fingerprint);
    require(original?.state==="in_progress"&&original.execution_run_id===plan.remediationExecutionRunId,"focused_remediation_changed");
    const finding=db.prepare("SELECT verdict,payload_json FROM security_audit_findings WHERE run_id=? AND fingerprint=?").get(plan.auditRunId,plan.fingerprint);
    require(finding?.verdict==="confirmed"&&typeof finding.payload_json==="string"&&hash(JSON.parse(finding.payload_json))===plan.originalRecordSha256,"focused_original_changed");
    const remediation=db.prepare("SELECT project_path,status,finished_at FROM execution_runs WHERE id=?").get(plan.remediationExecutionRunId);
    require(remediation?.project_path===plan.projectPath&&remediation.status==="succeeded"&&remediation.finished_at===plan.remediationFinishedAt,"focused_remediation_not_succeeded");
    const serialized=JSON.stringify(plan);
    db.prepare("INSERT INTO security_audit_focused_runs(execution_run_id,audit_run_id,fingerprint,project_path,remediation_execution_id,plan_json,plan_sha256,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(runId,plan.auditRunId,plan.fingerprint,plan.projectPath,plan.remediationExecutionRunId,serialized,digest(serialized),now());
  });
}
/** Charge before engine call; no automatic replay or third invocation. */
export function chargeFocusedVerificationAttempt(db:DatabaseSync,runId:string,request:FocusedVerificationRequest):void{
  tx(db,()=>{
    const plan=active(db,runId),prior=attempts(db,runId),ordinal=prior.length+1,expected=plan.verifiers[ordinal-1];
    require(expected&&ordinal<=2&&prior.every(row=>row.status==="succeeded"&&readReceipt(row)!==null),"focused_budget_or_previous_receipt");
    require(id(request.instanceId)&&hash(expected)===hash(request.verifier)&&request.fingerprint===plan.fingerprint&&
      request.snapshotSha256===plan.currentSnapshotSha256&&request.projectPath===plan.projectPath&&hash(request.allowedPaths)===hash(plan.scope.scopePaths)&&
      request.permissionProfile==="read-only"&&request.executionPolicy==="source-only"&&!request.signal.aborted,"focused_request_mismatch");
    db.prepare("INSERT INTO security_audit_focused_attempts(instance_id,execution_run_id,ordinal,agent_id,engine,model_id,started_at) VALUES(?,?,?,?,?,?,?)")
      .run(request.instanceId,runId,ordinal,expected.agentId,expected.engine,expected.modelId,now());
  });
}
/** Bind native engine result to actual execution_agents identity. Raw output
 * is never saved here, only its digest. */
export function recordFocusedEngineResult(db:DatabaseSync,runId:string,result:FocusedVerificationResult):void{
  tx(db,()=>{
    active(db,runId);
    const a=attempts(db,runId).find(row=>row.instance_id===result.instanceId);
    require(a?.status==="charged"&&result.verifier.agentId===a.agent_id&&result.verifier.engine===a.engine&&
      result.verifier.modelId===a.model_id&&result.agentRunId===result.instanceId&&id(result.handoffId)&&
      ["succeeded","failed","cancelled"].includes(result.status),"focused_result_mismatch");
    const agent=db.prepare("SELECT run_id,agent_id,engine,model_id,permission_profile,status,session_id FROM execution_agents WHERE id=?").get(result.agentRunId);
    require(agent?.run_id===runId&&agent.agent_id===a.agent_id&&agent.engine===a.engine&&agent.model_id===a.model_id&&
      agent.permission_profile==="read-only"&&agent.status===result.status&&agent.session_id===result.sessionId,"focused_agent_receipt_mismatch");
    if(result.status==="succeeded"){
      require(id(result.sessionId)&&typeof result.output==="string"&&result.output.length>0&&result.output.length<39900,"focused_missing_session_output");
      const others=db.prepare("SELECT count(*) AS n FROM execution_agents WHERE id<>? AND engine=? AND session_id=?").get(result.agentRunId,result.verifier.engine,result.sessionId);
      require(others?.n===0,"focused_session_reused");
    }
    require(result.sessionId===null||id(result.sessionId),"focused_invalid_session");
    db.prepare("UPDATE security_audit_focused_attempts SET status=?,agent_run_id=?,handoff_id=?,session_id=?,output_sha256=?,finished_at=? WHERE instance_id=?")
      .run(result.status,result.agentRunId,result.handoffId,result.sessionId,result.status==="succeeded"?digest(result.output):null,now(),result.instanceId);
  });
}
/** Internal parent-validated receipt hook; not a public input contract. */
export function acceptFocusedVerificationReceipt(db:DatabaseSync,runId:string,receipt:FocusedVerificationReceipt):void{
  tx(db,()=>{
    const plan=active(db,runId),a=attempts(db,runId).find(row=>row.instance_id===receipt.instanceId);
    require(a?.status==="succeeded"&&a.receipt_json===null&&receipt.agentRunId===a.agent_run_id&&receipt.handoffId===a.handoff_id&&
      receipt.sessionId===a.session_id&&receipt.verifier.agentId===a.agent_id&&receipt.verifier.engine===a.engine&&receipt.verifier.modelId===a.model_id&&
      receipt.outputSha256===a.output_sha256&&receipt.fingerprint===plan.fingerprint&&receipt.snapshotSha256===plan.currentSnapshotSha256&&
      receipt.officialValidator==="PASS"&&hash(receipt.record)===receipt.recordSha256&&receipt.record.fingerprint===plan.fingerprint&&
      ["fixed","still_present","needs_validation"].includes(receipt.decision)&&
      receipt.record.verdict===(receipt.decision==="fixed"?"rejected":receipt.decision==="still_present"?"confirmed":"needs_validation")&&
      Array.isArray(receipt.sourceChecks)&&receipt.sourceChecks.length>0&&receipt.sourceChecks.length<=64&&receipt.sourceChecks.every(c=>
        plan.scope.scopePaths.includes(c.file)&&Number.isSafeInteger(c.line)&&c.line>0&&hex(c.quoteSha256))&&
      receipt.sourceChecks.some(c=>c.file===plan.findingPath)&&
      (receipt.decision!=="fixed"||plan.scope.scopePaths.every(file=>receipt.sourceChecks.some(c=>c.file===file))),"focused_invalid_receipt");
    const previous=attempts(db,runId).filter(row=>row.instance_id!==a.instance_id);
    require(!previous.some(row=>row.session_id===receipt.sessionId||row.handoff_id===receipt.handoffId||row.agent_run_id===receipt.agentRunId),"focused_identity_reused");
    const serialized=JSON.stringify(receipt);require(serialized.length<64000,"focused_receipt_size");
    db.prepare("UPDATE security_audit_focused_attempts SET receipt_json=?,receipt_sha256=? WHERE instance_id=?").run(serialized,digest(serialized),receipt.instanceId);
  });
}
/** Consensus computed from persisted receipts; never updates remediation. */
export function finishFocusedVerificationLedger(db:DatabaseSync,runId:string,outcome:FocusedVerificationOutcome):void{
  tx(db,()=>{
    active(db,runId);
    const entries=attempts(db,runId),receipts=entries.map(readReceipt).filter(r=>r!==null);
    require(entries.length===outcome.attempted&&hash(receipts)===hash(outcome.receipts),"focused_outcome_mismatch");
    require(["evidence_ready","still_present","incomplete","cancelled"].includes(outcome.status),"focused_invalid_outcome");
    if(outcome.status==="evidence_ready"||outcome.status==="still_present"){
      const decision=outcome.status==="evidence_ready"?"fixed":"still_present";
      require(entries.length===2&&receipts.length===2&&receipts.every(r=>r.decision===decision)&&outcome.reason===null,"focused_no_consensus");
    }else require(typeof outcome.reason==="string"&&/^[a-z][a-z0-9_]{0,80}$/.test(outcome.reason),"focused_invalid_reason");
    db.prepare("UPDATE security_audit_focused_attempts SET status=?,finished_at=? WHERE execution_run_id=? AND status='charged'").run(outcome.status==="cancelled"?"cancelled":"interrupted",now(),runId);
    db.prepare("UPDATE security_audit_focused_runs SET status=?,reason=?,finished_at=? WHERE execution_run_id=? AND status='running'").run(outcome.status,outcome.reason,now(),runId);
  });
}
export function getFocusedVerificationLedger(db:DatabaseSync,runId:string){
  const row=getRun(db,runId);
  return {executionRunId:row.execution_run_id,plan:getPlan(row),status:row.status,reason:row.reason,createdAt:row.created_at,finishedAt:row.finished_at,
    attempts:attempts(db,runId).map(a=>({instanceId:a.instance_id,ordinal:a.ordinal,agentId:a.agent_id,engine:a.engine,modelId:a.model_id,status:a.status,
      sessionId:a.session_id,startedAt:a.started_at,finishedAt:a.finished_at,receipt:readReceipt(a)}))};
}

/** Recovery is called after the ordinary execution recovery has marked
 * interrupted executions terminal. Never replay a charged attempt or
 * manufacture a receipt; retain already accepted evidence for diagnosis. */
export function recoverFocusedVerificationLedgers(db:DatabaseSync):number {
  return tx(db,()=>{
    const rows=db.prepare("SELECT f.execution_run_id,e.status FROM security_audit_focused_runs f JOIN execution_runs e ON e.id=f.execution_run_id WHERE f.status='running' AND e.status IN ('interrupted','failed','cancelled','succeeded')").all() as Array<{execution_run_id:string;status:string}>;
    const timestamp=now();
    for(const row of rows){
      const cancelled=row.status==="cancelled";
      db.prepare("UPDATE security_audit_focused_attempts SET status=?,finished_at=? WHERE execution_run_id=? AND status='charged'").run(cancelled?"cancelled":"interrupted",timestamp,row.execution_run_id);
      db.prepare("UPDATE security_audit_focused_runs SET status=?,reason=?,finished_at=? WHERE execution_run_id=? AND status='running'").run(cancelled?"cancelled":"incomplete",cancelled?"cancelled_by_user":"execution_interrupted",timestamp,row.execution_run_id);
    }
    return rows.length;
  });
}

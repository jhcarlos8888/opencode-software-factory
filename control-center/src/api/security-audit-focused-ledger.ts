/** Internal durable evidence ledger. Separate from full audit and remediation
 * closure. Only the server-owned publication gate can certify a fix. */
import {createHash} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {homedir} from "node:os";
import {join} from "node:path";
import {claudeResultUsage,openCodeSessionUsage,type AuditTokenUsage} from "./security-audit-usage.js";
import type {FocusedRevalidationPlan} from "./security-audit-focused-revalidation.js";
import type {FocusedNativeSourceCheck} from "./security-audit-focused-native.js";
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
  const cols=new Set(db.prepare("PRAGMA table_info(security_audit_focused_attempts)").all().map(c=>String(c.name)));
  if(!cols.has("native_evidence_json"))db.exec("ALTER TABLE security_audit_focused_attempts ADD COLUMN native_evidence_json TEXT");
  if(!cols.has("native_evidence_sha256"))db.exec("ALTER TABLE security_audit_focused_attempts ADD COLUMN native_evidence_sha256 TEXT");
  if(!cols.has("usage_json"))db.exec("ALTER TABLE security_audit_focused_attempts ADD COLUMN usage_json TEXT");
  if(!cols.has("usage_session_id"))db.exec("ALTER TABLE security_audit_focused_attempts ADD COLUMN usage_session_id TEXT");
}
type RunRow={execution_run_id:string;audit_run_id:string;fingerprint:string;project_path:string;remediation_execution_id:string;plan_json:string;plan_sha256:string;status:string;reason:string|null;created_at:string;finished_at:string|null};
type AttemptRow={usage_json:string|null;usage_session_id:string|null;instance_id:string;execution_run_id:string;ordinal:number;agent_id:string;engine:string;model_id:string;status:string;agent_run_id:string|null;handoff_id:string|null;session_id:string|null;output_sha256:string|null;native_evidence_json:string|null;native_evidence_sha256:string|null;receipt_json:string|null;receipt_sha256:string|null;started_at:string;finished_at:string|null};
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
function nativeEvidence(value:unknown,plan:FocusedRevalidationPlan):FocusedNativeSourceCheck[]{
  require(Array.isArray(value)&&value.length>0&&value.length<=64,"focused_native_evidence_missing");
  const seen=new Set<string>();
  for(const n of value){
    require(n&&typeof n==="object"&&typeof n.file==="string"&&plan.scope.scopePaths.includes(n.file)&&
      Number.isSafeInteger(n.line)&&n.line>0&&hex(n.lineSha256),"focused_native_evidence_invalid");
    const key=JSON.stringify([n.file,n.line]);require(!seen.has(key),"focused_native_evidence_duplicate");seen.add(key);
  }
  return value.map(n=>({file:n.file,line:n.line,lineSha256:n.lineSha256}));
}
function verifyReceiptNative(a:AttemptRow,receipt:FocusedVerificationReceipt,plan:FocusedRevalidationPlan):void{
  require(a.native_evidence_json&&digest(a.native_evidence_json)===a.native_evidence_sha256,"focused_native_evidence_integrity");
  const native=nativeEvidence(JSON.parse(a.native_evidence_json),plan);
  require(receipt.sourceChecks.every(c=>native.some(n=>n.file===c.file&&n.line===c.line&&n.lineSha256===c.nativeLineSha256)&&
    (c.origin==="model_quote"||c.origin==="native_read"&&c.quoteSha256===c.nativeLineSha256)),"focused_native_receipt_mismatch");
  const locations=[...(Array.isArray(receipt.record.trace)?receipt.record.trace:[]),...(Array.isArray(receipt.record.evidence)?receipt.record.evidence:[])];
  require(locations.length>0&&locations.every(loc=>loc&&typeof loc==="object"&&receipt.sourceChecks.some(c=>c.file===loc.file&&c.line===loc.line)),"focused_native_location_missing");
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
    const plan=active(db,runId);
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
    const native=result.status==="succeeded"?JSON.stringify(nativeEvidence(result.nativeSourceChecks,plan)):null;
    db.prepare("UPDATE security_audit_focused_attempts SET status=?,agent_run_id=?,handoff_id=?,session_id=?,output_sha256=?,native_evidence_json=?,native_evidence_sha256=?,finished_at=? WHERE instance_id=?")
      .run(result.status,result.agentRunId,result.handoffId,result.sessionId,result.status==="succeeded"?digest(result.output):null,native,native===null?null:digest(native),now(),result.instanceId);
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
    verifyReceiptNative(a,receipt,plan);
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
/** Optional counters only. The SDK result must belong to the exact active
 * native agent. Metrics do not participate in security certification. */
export function storeFocusedClaudeUsage(db:DatabaseSync,runId:string,instanceId:string,sessionId:string,event:unknown):void {
  const usage=claudeResultUsage(event);
  if(!usage||!id(sessionId))return;
  db.prepare("UPDATE security_audit_focused_attempts SET usage_json=?,usage_session_id=? WHERE execution_run_id=? AND instance_id=? AND engine='claude' AND status='charged' AND (usage_session_id IS NULL OR usage_session_id=?) AND EXISTS(SELECT 1 FROM execution_agents a WHERE a.id=? AND a.run_id=? AND a.agent_id=security_audit_focused_attempts.agent_id AND a.engine='claude' AND a.model_id=security_audit_focused_attempts.model_id AND a.session_id=? AND a.permission_profile='read-only')").run(JSON.stringify(usage),sessionId,runId,instanceId,sessionId,instanceId,runId,sessionId);
}
function focusedUsage(db:DatabaseSync,runId:string,entries:AttemptRow[],databasePath:string):Map<string,{sessionId:string;usage:AuditTokenUsage}> {
  const result=new Map<string,{sessionId:string;usage:AuditTokenUsage}>();
  let local:DatabaseSync|null=null;
  const n=(v:unknown)=>typeof v==="number"&&Number.isSafeInteger(v)&&v>=0?v:null;
  try{
    for(const a of entries){
      try{
        const agent=db.prepare("SELECT run_id,agent_id,engine,model_id,session_id,permission_profile,status FROM execution_agents WHERE id=?").get(a.instance_id);
        if(agent?.run_id!==runId||agent.agent_id!==a.agent_id||agent.engine!==a.engine||agent.model_id!==a.model_id||agent.permission_profile!=="read-only"||!id(agent.session_id))continue;
        const sessionId=agent.session_id;
        if(a.session_id!==null&&a.session_id!==sessionId)continue;
        if(db.prepare("SELECT count(*) AS n FROM execution_agents WHERE engine=? AND session_id=?").get(a.engine,sessionId)?.n!==1)continue;
        let usage:AuditTokenUsage|null=null;
        if(a.engine==="opencode"){
          local??=new DatabaseSync(databasePath,{readOnly:true});
          usage=openCodeSessionUsage(local,{engine:a.engine,model:a.model_id,sessionId,startedAt:a.started_at,finishedAt:a.finished_at,outcome:a.status});
        }else if(a.engine==="claude"&&a.usage_session_id===sessionId&&typeof a.usage_json==="string"){
          const v=JSON.parse(a.usage_json);
          if(v?.source==="claude-sdk-result"&&(n(v.input)!==null||n(v.output)!==null))
            usage={source:"claude-sdk-result",input:n(v.input),output:n(v.output),reasoning:null,cacheRead:n(v.cacheRead),cacheWrite:n(v.cacheWrite),partial:v.partial!==false||a.status!=="succeeded"};
        }
        if(usage)result.set(a.instance_id,{sessionId,usage});
      }catch{/* Optional counters must not change evidence or status. */}
    }
  }finally{try{local?.close();}catch{}}
  return result;
}
export function getFocusedVerificationLedger(db:DatabaseSync,runId:string,databasePath=join(process.env.XDG_DATA_HOME||join(homedir(),".local","share"),"opencode","opencode.db")){
  const row=getRun(db,runId),entries=attempts(db,runId),usage=focusedUsage(db,runId,entries,databasePath);
  return {executionRunId:row.execution_run_id,plan:getPlan(row),status:row.status,reason:row.reason,createdAt:row.created_at,finishedAt:row.finished_at,
    attempts:entries.map(a=>({instanceId:a.instance_id,ordinal:a.ordinal,agentId:a.agent_id,engine:a.engine,modelId:a.model_id,status:a.status,
      sessionId:a.session_id,startedAt:a.started_at,finishedAt:a.finished_at,nativeEvidenceSha256:a.native_evidence_sha256,receipt:readReceipt(a),usage:usage.get(a.instance_id)?.usage??null}))};
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

/** Only the current, successfully terminated focused execution may certify
 * its exact remediation. The caller must freshly recompute the preflight
 * from actual source and official artifacts; do not accept HTTP evidence. */
export function publishFocusedVerification(db:DatabaseSync,runId:string,freshPlan:FocusedRevalidationPlan):void{
  tx(db,()=>{
    const row=getRun(db,runId),plan=getPlan(row);
    require(row.status==="evidence_ready"&&row.reason===null&&row.finished_at&&hash(freshPlan)===row.plan_sha256,"focused_closure_stale");
    const e=db.prepare("SELECT project_path,status,configuration_snapshot_json,started_at,finished_at FROM execution_runs WHERE id=?").get(runId);
    require(e?.status==="succeeded"&&e.project_path===plan.projectPath&&typeof e.configuration_snapshot_json==="string"&&
      JSON.parse(e.configuration_snapshot_json).focusedRevalidation?.planSha256===row.plan_sha256&&typeof e.started_at==="string"&&typeof e.finished_at==="string"&&
      Date.parse(e.started_at)>Date.parse(plan.remediationFinishedAt)&&Date.parse(e.finished_at)>=Date.parse(row.finished_at),"focused_closure_execution_mismatch");
    const finding=db.prepare("SELECT verdict,payload_json FROM security_audit_findings WHERE run_id=? AND fingerprint=?").get(row.audit_run_id,row.fingerprint);
    require(finding?.verdict==="confirmed"&&typeof finding.payload_json==="string"&&hash(JSON.parse(finding.payload_json))===plan.originalRecordSha256,"focused_original_changed");
    const remediation=db.prepare("SELECT state,execution_run_id,evidence_json FROM security_audit_remediations WHERE run_id=? AND fingerprint=?").get(row.audit_run_id,row.fingerprint);
    require(remediation?.state==="in_progress"&&remediation.execution_run_id===row.remediation_execution_id&&typeof remediation.evidence_json==="string","focused_remediation_changed");
    const rem=db.prepare("SELECT project_path,status,finished_at FROM execution_runs WHERE id=?").get(row.remediation_execution_id);
    require(rem?.status==="succeeded"&&rem.project_path===plan.projectPath&&rem.finished_at===plan.remediationFinishedAt,"focused_remediation_not_succeeded");
    const entries=attempts(db,runId);
    require(entries.length===2&&entries.every(a=>a.status==="succeeded"&&a.receipt_json!==null),"focused_closure_no_consensus");
    const receipts=entries.map((a,i)=>{
      const receipt=readReceipt(a),expected=plan.verifiers[i];
      require(receipt&&expected&&receipt.decision==="fixed"&&receipt.officialValidator==="PASS"&&
        receipt.fingerprint===plan.fingerprint&&receipt.snapshotSha256===plan.currentSnapshotSha256&&receipt.record.verdict==="rejected"&&
        receipt.record.fingerprint===plan.fingerprint&&hash(receipt.record)===receipt.recordSha256&&receipt.outputSha256===a.output_sha256&&
        receipt.instanceId===a.instance_id&&receipt.agentRunId===a.agent_run_id&&receipt.handoffId===a.handoff_id&&receipt.sessionId===a.session_id&&
        hash(receipt.verifier)===hash(expected)&&receipt.sourceChecks.every(c=>plan.scope.scopePaths.includes(c.file)&&Number.isSafeInteger(c.line)&&c.line>0&&hex(c.quoteSha256))&&
        plan.scope.scopePaths.every(p=>receipt.sourceChecks.some(c=>c.file===p)),"focused_closure_receipt_mismatch");
      verifyReceiptNative(a,receipt,plan);
      const agent=db.prepare("SELECT run_id,agent_id,engine,model_id,permission_profile,status,session_id FROM execution_agents WHERE id=?").get(receipt.agentRunId);
      require(agent?.run_id===runId&&agent.agent_id===expected.agentId&&agent.engine===expected.engine&&agent.model_id===expected.modelId&&agent.permission_profile==="read-only"&&agent.status==="succeeded"&&agent.session_id===receipt.sessionId,"focused_agent_receipt_mismatch");
      return receipt;
    });
    require(receipts[0]!.sessionId!==receipts[1]!.sessionId&&receipts[0]!.agentRunId!==receipts[1]!.agentRunId&&receipts[0]!.handoffId!==receipts[1]!.handoffId,"focused_identity_reused");
    const prior=JSON.parse(remediation.evidence_json);
    require(Array.isArray(prior),"focused_invalid_remediation_evidence");
    const evidence={kind:"focused_revalidation",fullAudit:false,executionRunId:runId,fingerprint:plan.fingerprint,
      originalRecordSha256:plan.originalRecordSha256,originalFileSha256:plan.originalFileSha256,currentFileSha256:plan.currentFileSha256,
      snapshotSha256:plan.currentSnapshotSha256,scopePaths:plan.scope.scopePaths,
      verifiers:receipts.map(r=>({instanceId:r.instanceId,agentRunId:r.agentRunId,handoffId:r.handoffId,sessionId:r.sessionId,
        ...r.verifier,recordSha256:r.recordSha256,outputSha256:r.outputSha256,nativeEvidenceSha256:entries.find(a=>a.instance_id===r.instanceId)?.native_evidence_sha256,officialValidator:r.officialValidator})),verifiedAt:now()};
    const changed=db.prepare("UPDATE security_audit_remediations SET state='verified_fixed',evidence_json=?,updated_at=?,completed_at=? WHERE run_id=? AND fingerprint=? AND state='in_progress' AND execution_run_id=?")
      .run(JSON.stringify([...prior,evidence]),evidence.verifiedAt,evidence.verifiedAt,row.audit_run_id,row.fingerprint,row.remediation_execution_id);
    require(Number(changed.changes)===1,"focused_remediation_changed");
  });
}

/** Latest durable execution for each remediation, including partial failure. */
export function latestFocusedVerificationLedger(db:DatabaseSync,auditRunId:string,fingerprint:string){
  const row=db.prepare("SELECT execution_run_id FROM security_audit_focused_runs WHERE audit_run_id=? AND fingerprint=? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(auditRunId,fingerprint);
  return typeof row?.execution_run_id==="string"?getFocusedVerificationLedger(db,row.execution_run_id):null;
}

import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SecurityAuditInvocationRow } from "./security-audit-persistence.js";

export interface AuditTokenUsage {
  source: "opencode-session" | "claude-sdk-result";
  input: number | null;
  output: number | null;
  reasoning: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  partial: boolean;
}
function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function claudeResultUsage(result: unknown): AuditTokenUsage | null {
  const event = object(result);
  if (event.type !== "result") return null;
  const usage = object(event.usage);
  if (count(usage.input_tokens) === null && count(usage.output_tokens) === null) return null;
  return {source:"claude-sdk-result",input:count(usage.input_tokens),output:count(usage.output_tokens),
    reasoning:null,cacheRead:count(usage.cache_read_input_tokens),cacheWrite:count(usage.cache_creation_input_tokens),
    partial:event.subtype !== "success" || event.is_error === true};
}

/** Only a real audit invocation and its exact SDK session can receive a receipt. */
export function storeClaudeAuditUsage(db: DatabaseSync, instanceId: string, sessionId: string, result: unknown): void {
  const usage = claudeResultUsage(result);
  if (!usage || !sessionId) return;
  db.prepare(`INSERT INTO security_audit_usage(instance_id, session_id, usage_json)
    SELECT instance_id, session_id, ? FROM security_audit_invocations
    WHERE instance_id = ? AND session_id = ? AND engine = 'claude'
    ON CONFLICT(instance_id) DO UPDATE SET usage_json = excluded.usage_json
    WHERE security_audit_usage.session_id = excluded.session_id`).run(JSON.stringify(usage),instanceId,sessionId);
}

/** Query only numeric usage and identity fields for the known session. Never
 * return prompts, tool calls, assistant text, credentials or provider cost.
 * Older schemas, unavailable DBs and mismatched identities stay unknown. */
export function openCodeSessionUsage(db: DatabaseSync, invocation: SecurityAuditInvocationRow): AuditTokenUsage | null {
  if (invocation.engine !== "opencode" || !invocation.sessionId || !invocation.model) return null;
  const row = db.prepare(`SELECT parent_id, model, time_created, time_updated, tokens_input, tokens_output,
    tokens_reasoning, tokens_cache_read, tokens_cache_write
    FROM session_v2 WHERE id = ?`).get(invocation.sessionId);
  if (!row || row.parent_id !== null || typeof row.model !== "string") return null;
  const model = object(JSON.parse(row.model));
  if (typeof model.id !== "string" || typeof model.providerID !== "string" ||
      model.providerID + "/" + model.id !== invocation.model) return null;
  const started = Date.parse(invocation.startedAt), finished = invocation.finishedAt ? Date.parse(invocation.finishedAt) : null;
  if (!Number.isFinite(started) || typeof row.time_created !== "number" || typeof row.time_updated !== "number" ||
      row.time_created < started - 5000 || row.time_updated < row.time_created || (finished !== null && (!Number.isFinite(finished) || row.time_created > finished || row.time_updated > finished + 10000))) return null;
  // An initialized session without assistant usage is not evidence of zero consumption.
  const messages = db.prepare(`SELECT count(*) AS n FROM session_message
    WHERE session_id = ? AND type = 'assistant' AND json_valid(data)
    AND json_type(data,'$.tokens.input') IN ('integer','real')`).get(invocation.sessionId);
  if (!messages || Number(messages.n) < 1) return null;
  return {source:"opencode-session",input:count(row.tokens_input),output:count(row.tokens_output),
    reasoning:count(row.tokens_reasoning),cacheRead:count(row.tokens_cache_read),cacheWrite:count(row.tokens_cache_write),
    partial:invocation.outcome !== "succeeded"};
}
export function auditInvocationUsage(factoryDb: DatabaseSync, invocations: readonly SecurityAuditInvocationRow[],
    databasePath = join(process.env.XDG_DATA_HOME || join(homedir(),".local","share"),"opencode","opencode.db")): Map<string,AuditTokenUsage> {
  const output = new Map<string,AuditTokenUsage>();
  let local: DatabaseSync | null = null;
  const counts = new Map<string,number>();
  for (const inv of invocations) if (inv.sessionId) counts.set(inv.sessionId,(counts.get(inv.sessionId) ?? 0)+1);
  try {
    for (const inv of invocations) {
      if (!inv.sessionId || counts.get(inv.sessionId) !== 1) continue;
      try {
        let usage: AuditTokenUsage | null = null;
        if (inv.engine === "opencode") {
          local ??= new DatabaseSync(databasePath,{readOnly:true});
          usage = openCodeSessionUsage(local,inv);
        } else if (inv.engine === "claude") {
          const row = factoryDb.prepare("SELECT usage_json FROM security_audit_usage WHERE instance_id=? AND session_id=?").get(inv.instanceId,inv.sessionId);
          if (typeof row?.usage_json === "string") {
            const v = object(JSON.parse(row.usage_json));
            if (v.source === "claude-sdk-result") usage = {source:"claude-sdk-result",input:count(v.input),output:count(v.output),
              reasoning:null,cacheRead:count(v.cacheRead),cacheWrite:count(v.cacheWrite),partial:v.partial !== false || inv.outcome !== "succeeded"};
          }
        }
        if (usage) output.set(inv.instanceId,usage);
      } catch { /* Metrics are optional: no audit outcome depends on this. */ }
    }
  } finally { try { local?.close(); } catch {} }
  return output;
}

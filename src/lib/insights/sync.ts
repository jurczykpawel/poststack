import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels, insightConnections } from "@/db/schema";
import { requireFeature } from "@/lib/license/gate";
import type { InsightsSyncJob } from "@/lib/queue/types";
import { resolveInsightCredential } from "./credentials";
import { getInsightsConnector } from "./catalog";
import { loadInsightContext } from "./repository";
import { storeInsightBatch } from "./service";
import { collectionQueries, dailyDue, DAY, retryDue, sharedBudgetKey, usageDue, readSyncCursor, syncCheckpoint, attemptRevision } from "./schedule";
import type { ChannelRef, InsightCredential, InsightFailure, InsightQuery } from "./types";

const scope=(ref:ChannelRef)=>and(eq(insightConnections.workspace_id,ref.workspaceId),eq(insightConnections.channel_id,ref.channelId));
const owned=(ref:ChannelRef,claim:string)=>and(scope(ref),eq(insightConnections.claim_token,claim),sql`${insightConnections.claim_until} > now()`,eq(insightConnections.collection_mode,"on"));
async function eligible(ref:ChannelRef,credential?:InsightCredential) {
  await requireFeature("insights");
  const context=await loadInsightContext(ref);
  if(context.channel.status!=="active" || context.connection?.collection_mode!=="on") return null;
  const current=await resolveInsightCredential(ref,credential?.transport ?? context.connection.transport);
  if(!current || (credential && current.revision!==credential.revision)) return null;
  if(["missing_permission","needs_reauth","unsupported"].includes(context.connection.access_state) && context.connection.credential_revision===current.revision) return null;
  return { ...context, credential:current };
}

/** Reservation precedes every HTTP attempt, including access checks and failed calls. */
async function reserve(ref:ChannelRef,credential:InsightCredential,claim:string):Promise<boolean> {
  const context=await eligible(ref,credential);
  if(!context) return false;
  const key=sharedBudgetKey(credential.budgetKey);
  return db.transaction(async tx=>{
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([ref.workspaceId,key])},0))`);
    const [channel]=await tx.select().from(channels).where(and(eq(channels.workspace_id,ref.workspaceId),eq(channels.id,ref.channelId))).for("update");
    if(!channel || channel.deleted_at || channel.status!=="active") return false;
    const group=await tx.select().from(insightConnections).where(and(eq(insightConnections.workspace_id,ref.workspaceId),eq(insightConnections.budget_key,key))).orderBy(insightConnections.channel_id).for("update");
    const connection=group.find(c=>c.channel_id===ref.channelId);
    const now=new Date();
    if(!connection || connection.collection_mode!=="on" || connection.claim_token!==claim || !connection.claim_until || connection.claim_until<=now || connection.credential_revision!==credential.revision) return false;
    await requireFeature("insights");
    const times=group.flatMap(c=>c.usage_budget.requestTimes).filter(t=>Date.parse(t)>now.getTime()-DAY).sort();
    const floor=Math.max(0,...group.map(c=>Math.max(c.backoff_until?.getTime() ?? 0,Date.parse(c.usage_budget.nextSafeAt ?? "") || 0)));
    const next=times.length>=120 ? Math.max(floor,Date.parse(times[0])+DAY) : floor;
    if(next>now.getTime()) {
      await tx.update(insightConnections).set({next_due_at:new Date(next),backoff_until:new Date(next),reason:"rate_limited"}).where(owned(ref,claim));
      return false;
    }
    const ownTimes=connection.usage_budget.requestTimes.filter(t=>Date.parse(t)>now.getTime()-DAY);
    await tx.update(insightConnections).set({last_attempt_at:now,claim_until:new Date(now.getTime()+180000),usage_budget:{...connection.usage_budget,requestTimes:[...ownTimes,now.toISOString()]}}).where(owned(ref,claim));
    return true;
  });
}

async function deferGroup(ref:ChannelRef,credential:InsightCredential,claim:string,until:Date,percent:number|null):Promise<void> {
  const key=sharedBudgetKey(credential.budgetKey);
  await db.transaction(async tx=>{
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([ref.workspaceId,key])},0))`);
    const rows=await tx.select().from(insightConnections).where(and(eq(insightConnections.workspace_id,ref.workspaceId),eq(insightConnections.budget_key,key))).orderBy(insightConnections.channel_id).for("update");
    if(!rows.some(r=>r.channel_id===ref.channelId && r.claim_token===claim && r.claim_until && r.claim_until>new Date() && r.collection_mode==="on" && r.credential_revision===credential.revision)) return;
    for(const row of rows) {
      const floor=new Date(Math.max(until.getTime(),row.backoff_until?.getTime() ?? 0,Date.parse(row.usage_budget.nextSafeAt ?? "")||0));
      await tx.update(insightConnections).set({backoff_until:floor,next_due_at:floor,usage_budget:{...row.usage_budget,nextSafeAt:floor.toISOString(),usagePercent:percent===null ? null : Math.min(100,Math.max(0,percent))}}).where(and(eq(insightConnections.workspace_id,ref.workspaceId),eq(insightConnections.channel_id,row.channel_id)));
    }
  });
}

export async function processInsightsSync(payload:InsightsSyncJob):Promise<void> {
  const ref={workspaceId:payload.workspaceId,channelId:payload.channelId};
  let context:Awaited<ReturnType<typeof eligible>>;
  try { context=await eligible(ref); } catch { return; }
  if(!context || (payload.credentialRevision && payload.credentialRevision!==context.credential.revision)) return;
  const {credential}=context;
  const connector=getInsightsConnector(context.channel.platform);
  if(!connector) return;
  const claim=randomUUID();
  const now=new Date();
  const claimed=await db.update(insightConnections).set({claim_token:claim,claim_until:new Date(now.getTime()+180000),transport:credential.transport,credential_revision:credential.revision,budget_key:sharedBudgetKey(credential.budgetKey),
    ...(context.connection && attemptRevision(context.connection)!==credential.revision?{failure_count:0,access_state:"unknown" as const}:{}),
  }).where(and(scope(ref),eq(insightConnections.collection_mode,"on"),
    sql`${insightConnections.credential_revision} IS NOT DISTINCT FROM ${context.connection?.credential_revision ?? null}`,
    sql`${insightConnections.transport} IS NOT DISTINCT FROM ${context.connection?.transport ?? null}`,
    sql`(${insightConnections.claim_until} IS NULL OR ${insightConnections.claim_until} <= now())`,sql`${insightConnections.next_due_at} <= now()`)).returning();
  if(!claimed.length) return;
  let requests=0;
  const request=async(query:InsightQuery)=>{
    if(requests>=10 || !await reserve(ref,credential,claim)) return null;
    requests++;
    return connector.fetch(credential,query);
  };
  try {
    const saved=readSyncCursor(claimed[0].checkpoint);
    const unsupported=saved.revision===credential.revision ? saved.unsupported : [];
    const metrics=connector.catalog().filter(m=>m.level==="account" && m.grain==="day").map(m=>m.key);
    const queries=collectionQueries(now,credential.accountKey,metrics.filter(m=>!unsupported.includes(m)),claimed[0].checkpoint)
      .map((query,index)=>({query,advance:index>=4 ? query.from : undefined}));
    if(!queries[0]?.query.metrics.length) return;
    if(claimed[0].access_state==="unknown" && claimed[0].failure_count>=3 && context.connection && attemptRevision(context.connection)===credential.revision) return;
    let splitUsed=false;
    for(let i=0;i<queries.length && requests<10;i++) {
      const {advance}=queries[i];
      const query={...queries[i].query,metrics:queries[i].query.metrics.filter(m=>!unsupported.includes(m))};
      if(!query.metrics.length) continue;
      let batch;
      try { batch=await request(query); if(!batch) return; }
      catch(error) {
        if((error as InsightFailure)?.kind!=="unsupported_metric") throw error;
        if(query.metrics.length>1) {
          if(splitUsed) throw error;
          splitUsed=true;
          queries.splice(i+1,0,...query.metrics.map((metric,index)=>({query:{...query,metrics:[metric]},advance:index===query.metrics.length-1 ? advance : undefined})));
          continue;
        }
        unsupported.push(query.metrics[0]);
        const checkpoint=syncCheckpoint(claimed[0].checkpoint,readSyncCursor(claimed[0].checkpoint).before,credential.revision,unsupported);
        const allUnsupported=metrics.every(m=>unsupported.includes(m));
        await storeInsightBatch(ref,credential.revision,{observations:[],usage:{percent:null,regainAfterSeconds:null}},claim,{checkpoint,next_due_at:dailyDue(now),...(allUnsupported?{access_state:"unsupported" as const,reason:"permission_required" as const}:{})});
        claimed[0].checkpoint=checkpoint;
        if(allUnsupported) return;
        continue;
      }
      if(!await eligible(ref,credential)) return;
      const checkpoint=syncCheckpoint(claimed[0].checkpoint,advance ?? readSyncCursor(claimed[0].checkpoint).before,credential.revision,unsupported);
      await storeInsightBatch(ref,credential.revision,batch,claim,{checkpoint,access_state:"ready",access_checked_at:new Date(),failure_count:0,reason:"none",next_due_at:i===queries.length-1?dailyDue(now):new Date(Date.now()+900000)});
      claimed[0].checkpoint=checkpoint;
      claimed[0].access_state="ready";claimed[0].failure_count=0;
      const usage=usageDue(new Date(),batch.usage.percent,batch.usage.regainAfterSeconds);
      if(usage) { await deferGroup(ref,credential,claim,usage,batch.usage.percent); return; }
    }
    if(!await eligible(ref,credential)) return;
    await storeInsightBatch(ref,credential.revision,{observations:[],usage:{percent:null,regainAfterSeconds:null}},claim,{checkpoint:claimed[0].checkpoint,access_state:"ready",access_checked_at:new Date(),failure_count:0,reason:"none",next_due_at:dailyDue(now)});
  } catch(error) {
    if(!await eligible(ref,credential).catch(()=>null)) return;
    const failure=error as InsightFailure;
    const failures=claimed[0].failure_count+1;
    const until=retryDue(new Date(),failures,failure?.retryAfterSeconds ?? null);
    const state=failure?.kind==="invalid_token"?"needs_reauth":failure?.kind==="missing_permission"?"missing_permission":claimed[0].access_state;
    await db.update(insightConnections).set({checkpoint:syncCheckpoint(claimed[0].checkpoint,readSyncCursor(claimed[0].checkpoint).before,credential.revision,readSyncCursor(claimed[0].checkpoint).unsupported),failure_count:failures,access_state:state,reason:state==="needs_reauth"?"token_required":state==="missing_permission"?"permission_required":failure?.kind==="rate_limited"?"rate_limited":"provider_unavailable",next_due_at:until,backoff_until:until}).where(owned(ref,claim));
    await deferGroup(ref,credential,claim,until,null);
  } finally {
    await db.update(insightConnections).set({claim_token:null,claim_until:null}).where(and(scope(ref),eq(insightConnections.claim_token,claim)));
  }
}

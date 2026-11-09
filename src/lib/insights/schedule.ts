import { INSIGHT_RANGES, providerToday, providerDayStart, shiftInsightDay } from "./calendar";
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels, insightConnections, workspaces, type InsightCheckpoint } from "@/db/schema";
import { requireFeature } from "@/lib/license/gate";
import { addJobTx } from "@/lib/queue/client";
import { resolveInsightCredential } from "./credentials";
import { getInsightsConnector } from "./catalog";
import type { ChannelRef, InsightQuery } from "./types";

export const DAY = 86400000;
export function dailyDue(now: Date, rng = Math.random): Date {
  return new Date(now.getTime() + DAY + Math.floor(rng()*3600000));
}
export function retryDue(now: Date, failures: number, retrySeconds: number | null, rng = Math.random): Date {
  const base = [60000,300000,900000,3600000][failures-1] ?? DAY;
  return new Date(now.getTime()+Math.max(Math.min(DAY,base+Math.floor(rng()*30000)), (retrySeconds ?? 0)*1000));
}
export function usageDue(now: Date, percent: number | null, regain: number | null): Date | null {
  const delay=Math.max((regain ?? 0)*1000,(percent ?? 0)>=90?3600000:(percent ?? 0)>=80?900000:0);
  return delay ? new Date(now.getTime()+delay) : null;
}
export function insightLane(workspaceId: string, budgetKey: string): string {
  return `insights:${createHash("sha256").update(JSON.stringify([workspaceId,budgetKey])).digest()[0]%2}`;
}
/** Unidentified app-user credentials share a conservative workspace pool. */
export function sharedBudgetKey(key: string): string {
  return key.startsWith("meta-source:") ? key : "meta:unidentified-user";
}
export function readSyncCursor(checkpoint: InsightCheckpoint): {before?: string; revision?: string; unsupported: string[]} {
  const raw=checkpoint.cursor;
  if(!raw) return {unsupported:[]};
  if(Number.isFinite(Date.parse(raw))) return {before:raw,unsupported:[]};
  try {
    const value=JSON.parse(raw);
    if(value && Array.isArray(value.unsupported) && value.unsupported.every((key:unknown)=>typeof key === "string" && key.length<=128)) return value;
  } catch { /* Restart history from the bounded window. */ }
  return {unsupported:[]};
}
export function attemptRevision(connection: {checkpoint: InsightCheckpoint; credential_revision: string | null}): string | null {
  return readSyncCursor(connection.checkpoint).revision ?? connection.credential_revision;
}
export function syncCheckpoint(checkpoint: InsightCheckpoint, before: string | undefined, revision: string, unsupported: string[]): InsightCheckpoint {
  return {...checkpoint,cursor:JSON.stringify({before,revision,unsupported})};
}
export function collectionQueries(now: Date, subjectKey: string, metrics: readonly string[], checkpoint: InsightCheckpoint, ranges?: { timeZone?: string; rangeMetrics: readonly string[] }): InsightQuery[] {
  const end = Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate());
  const query=(from:number,to:number):InsightQuery=>({level:"account",subjectKey,metrics,grain:"day",from:new Date(from).toISOString(),to:new Date(to).toISOString()});
  const queries=[1,2,3].map(d=>query(end-d*DAY,end-(d-1)*DAY));
  queries.push(query(end-7*DAY,end-3*DAY));
  if (ranges?.rangeMetrics.length) {
    const today = providerToday(ranges.timeZone, now);
    for (const days of INSIGHT_RANGES) queries.push({level:"account",subjectKey,metrics:ranges.rangeMetrics,grain:"range",
      from:providerDayStart(shiftInsightDay(today,-days),ranges.timeZone),to:providerDayStart(today,ranges.timeZone)});
  }
  const saved=Date.parse(readSyncCursor(checkpoint).before ?? "");
  let cursor=Number.isFinite(saved) ? Math.min(saved,end-7*DAY) : end-7*DAY;
  const floor=end-90*DAY;
  while(queries.length<10 && cursor>floor) {
    const start=Math.max(floor,cursor-7*DAY);
    queries.push(query(start,cursor)); cursor=start;
  }
  return queries;
}

export async function enqueueInsights(ref: ChannelRef, reason: "enable"|"consent"|"refresh"|"scheduled"): Promise<{queued:boolean;nextRetryAt:string|null}> {
  await requireFeature("insights");
  const [selected]=await db.select({transport:insightConnections.transport}).from(insightConnections).where(and(eq(insightConnections.workspace_id,ref.workspaceId),eq(insightConnections.channel_id,ref.channelId)));
  if(!selected) return {queued:false,nextRetryAt:null};
  const credential=await resolveInsightCredential(ref,selected.transport);
  if (!credential) return {queued:false,nextRetryAt:null};
  const key=sharedBudgetKey(credential.budgetKey);
  return db.transaction(async tx=>{
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([ref.workspaceId,key])},0))`);
    const [channel]=await tx.select().from(channels).where(and(eq(channels.workspace_id,ref.workspaceId),eq(channels.id,ref.channelId),sql`${channels.deleted_at} IS NULL`)).for("update");
    if (!channel || channel.status!=="active" || !getInsightsConnector(channel.platform)) return {queued:false,nextRetryAt:null};
    const [connection]=await tx.select().from(insightConnections).where(and(eq(insightConnections.workspace_id,ref.workspaceId),eq(insightConnections.channel_id,ref.channelId))).for("update");
    if (!connection || connection.collection_mode!=="on" || connection.transport!==selected.transport) return {queued:false,nextRetryAt:null};
    await requireFeature("insights");
    const now=new Date();
    const group=await tx.select().from(insightConnections).where(and(eq(insightConnections.workspace_id,ref.workspaceId),eq(insightConnections.budget_key,key)));
    const times=group.flatMap(c=>c.usage_budget.requestTimes).filter(t=>Date.parse(t)>now.getTime()-DAY).sort();
    const sharedFloor=Math.max(0,...group.map(c=>Math.max(c.backoff_until?.getTime() ?? 0,Date.parse(c.usage_budget.nextSafeAt ?? "")||0)));
    const floor=Math.max(sharedFloor,times.length>=120 ? Date.parse(times[0])+DAY:0,connection.backoff_until?.getTime() ?? 0, connection.usage_budget.nextSafeAt ? Date.parse(connection.usage_budget.nextSafeAt):0,
      reason==="refresh" && connection.last_refresh_at ? connection.last_refresh_at.getTime()+900000:0);
    if (floor>now.getTime()) return {queued:false,nextRetryAt:new Date(floor).toISOString()};
    if (["missing_permission","needs_reauth","unsupported"].includes(connection.access_state) && connection.credential_revision===credential.revision) return {queued:false,nextRetryAt:null};
    if(reason!=="refresh" && connection.access_state==="unknown" && connection.failure_count>=3 && attemptRevision(connection)===credential.revision) {
      await tx.update(insightConnections).set({next_due_at:dailyDue(now)}).where(and(eq(insightConnections.workspace_id,ref.workspaceId),eq(insightConnections.channel_id,ref.channelId)));
      return {queued:false,nextRetryAt:null};
    }
    await tx.update(insightConnections).set({budget_key:key, ...(reason==="refresh" && connection.access_state==="unknown" && connection.failure_count>=3 ? {failure_count:2}:{}), ...(reason==="refresh"?{last_refresh_at:now}:{}),next_due_at:now})
      .where(and(eq(insightConnections.workspace_id,ref.workspaceId),eq(insightConnections.channel_id,ref.channelId)));
    await addJobTx(tx,"insights-sync",{...ref,credentialRevision:credential.revision},{jobKey:`insights:${ref.workspaceId}:${ref.channelId}`,queueName:insightLane(ref.workspaceId,key),priority:100});
    return {queued:true,nextRetryAt:null};
  });
}

export async function sweepInsights(now = new Date()): Promise<void> {
  try { await requireFeature("insights"); } catch { return; }
  for (const workspace of await db.select({id:workspaces.id}).from(workspaces)) {
    const due=await db.select({channelId:insightConnections.channel_id}).from(insightConnections).where(and(
      eq(insightConnections.workspace_id,workspace.id),eq(insightConnections.collection_mode,"on"),sql`${insightConnections.next_due_at} <= ${now}`,
      sql`(${insightConnections.claim_until} IS NULL OR ${insightConnections.claim_until} <= now())`,
      sql`${insightConnections.access_state} IN ('unknown','ready')`)).limit(100);
    for(const row of due) await enqueueInsights({workspaceId:workspace.id,channelId:row.channelId},"scheduled");
  }
}

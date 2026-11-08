import { createHash } from "node:crypto";
import { and, eq, gte, lte, inArray, isNull, sql } from "drizzle-orm";
import { channels, accountSources, insightConnections, insightObservations } from "@/db/schema";
import { db } from "@/lib/db";
import { requireFeature } from "@/lib/license/gate";
import { reconcileInsightCredentials } from "./lifecycle";
import { resolveInsightCredential } from "./credentials";
import type { ChannelRef, CollectionMode, InsightBatch, InsightObservation, InsightQuery } from "./types";

export async function loadInsightContext(ref: ChannelRef): Promise<{ channel: Pick<typeof channels.$inferSelect, "platform" | "platform_id" | "status">; connection: typeof insightConnections.$inferSelect | null }> {
  const [channel] = await db.select({ platform: channels.platform, platform_id: channels.platform_id, status: channels.status })
    .from(channels).where(and(eq(channels.workspace_id, ref.workspaceId), eq(channels.id, ref.channelId), sql`${channels.deleted_at} IS NULL`));
  if (!channel) throw new Error("Channel not found");
  if (channel.platform === "instagram") await reconcileInsightCredentials(ref);
  const [connection] = await db.select().from(insightConnections).where(and(eq(insightConnections.workspace_id, ref.workspaceId), eq(insightConnections.channel_id, ref.channelId)));
  return { channel, connection: connection ?? null };
}

function observation(row: typeof insightObservations.$inferSelect): InsightObservation {
  return { platform: row.platform, metricKey: row.metric_key, level: row.level, subjectKey: row.subject_key,
    grain: row.grain, period: row.period, metricType: row.metric_type,
    windowStart: row.window_start.toISOString(), windowEnd: row.window_end.toISOString(), snapshotDay: row.snapshot_day,
    fetchedAt: row.fetched_at.toISOString(), providerDay: row.provider_day, boundaryBasis: row.boundary_basis,
    value: row.scalar, state: row.response_state, dimensions: row.dimensions, queryParams: row.query_params,
    transport: row.transport, apiVersion: row.api_version, definitionVersion: row.definition_version, coverageBasis: row.coverage_basis };
}

/** Both comparison windows are read in one bounded query. */
export async function readObservations(ref: ChannelRef, query: InsightQuery): Promise<InsightObservation[]> {
  const previous = new Date(Date.parse(query.from) - (Date.parse(query.to) - Date.parse(query.from)));
  const rows = await db.select().from(insightObservations).where(and(
    eq(insightObservations.workspace_id, ref.workspaceId), eq(insightObservations.channel_id, ref.channelId),
    inArray(insightObservations.metric_key, [...query.metrics]), eq(insightObservations.level, query.level), eq(insightObservations.subject_key, query.subjectKey),
    gte(insightObservations.window_start, previous), lte(insightObservations.window_end, new Date(query.to)),
  ));
  return rows.map(observation);
}

export async function changeCollectionMode(ref: ChannelRef, mode: CollectionMode): Promise<void> {
  await db.transaction(async (tx) => {
    const [channel] = await tx.select().from(channels).where(and(eq(channels.workspace_id, ref.workspaceId), eq(channels.id, ref.channelId), sql`${channels.deleted_at} IS NULL`)).for("update");
    if (!channel) throw new Error("Channel not found");
    await requireFeature("insights");
    if (mode === "off") await tx.update(channels).set({ metadata: sql`${channels.metadata} - 'insight_consent' - 'insight_consent_completion'` }).where(and(eq(channels.workspace_id, ref.workspaceId), eq(channels.id, ref.channelId)));
    await tx.insert(insightConnections).values({ workspace_id: ref.workspaceId, channel_id: ref.channelId, platform: channel.platform, collection_mode: mode,
      reason: mode === "off" ? "collection_off" : "first_sync" })
      .onConflictDoUpdate({ target: [insightConnections.workspace_id, insightConnections.channel_id],
        set: { collection_mode: mode, reason: mode === "off" ? "collection_off" : "first_sync", credential_revision: null,
          access_state: "unknown", access_checked_at: null, claim_token: null, claim_until: null, next_due_at: new Date() },
        setWhere: and(eq(insightConnections.workspace_id, ref.workspaceId), sql`${insightConnections.collection_mode} <> ${mode}`) });
  });
}

function sortedMap(map: Record<string, string>) {
  return Object.fromEntries(Object.entries(map).sort(([a], [b]) => a === b ? 0 : a < b ? -1 : 1));
}

/** Actual observation windows replace the enclosing daily fetch window. */
export function insightQueryKey(o: InsightObservation): string {
  const params = { ...o.queryParams };
  for (const key of ["metric", "metric_type", "period"]) delete params[key];
  if (o.grain === "day") for (const key of ["since", "until", "from", "to"]) delete params[key];
  return createHash("sha256").update(JSON.stringify([
    o.metricKey, o.level, o.subjectKey, o.grain, o.period, o.metricType,
    new Date(o.windowStart).toISOString(), new Date(o.windowEnd).toISOString(),
    sortedMap(params), sortedMap(o.dimensions), o.boundaryBasis,
    o.transport, o.apiVersion, o.definitionVersion, o.coverageBasis,
  ])).digest("hex");
}

export async function upsertInsightBatch(ref: ChannelRef, revision: string, batch: InsightBatch, claimToken?: string): Promise<number> {
  return db.transaction(async (tx) => {
    const [initial] = await tx.select({ sourceId: channels.source_id }).from(channels).where(and(eq(channels.workspace_id, ref.workspaceId), eq(channels.id, ref.channelId)));
    if (!initial) return 0;
    if (initial.sourceId) await tx.select({ id: accountSources.id }).from(accountSources).where(and(eq(accountSources.workspace_id, ref.workspaceId), eq(accountSources.id, initial.sourceId))).for("update");
    const [channel] = await tx.select().from(channels).where(and(eq(channels.workspace_id, ref.workspaceId), eq(channels.id, ref.channelId))).for("update");
    if (!channel || channel.deleted_at || channel.status !== "active" || channel.source_id !== initial.sourceId) return 0;
    const [connection] = await tx.select().from(insightConnections).where(and(
      eq(insightConnections.workspace_id, ref.workspaceId), eq(insightConnections.channel_id, ref.channelId),
      claimToken === undefined ? isNull(insightConnections.claim_token) : and(eq(insightConnections.claim_token, claimToken), sql`${insightConnections.claim_until} > now()`),
    )).for("update");
    if (!connection || connection.collection_mode !== "on" || connection.credential_revision !== revision || !connection.transport) return 0;
    if (channel.platform === "instagram") {
      const credential = await resolveInsightCredential(ref, connection.transport);
      if (!credential || credential.revision !== revision) return 0;
    }
    await requireFeature("insights");
    let count = 0;
    let latest: Date | null = null;
    for (const o of batch.observations) {
      if (o.platform !== channel.platform || o.transport !== connection.transport || o.state !== "available") continue;
      const fetchedAt = new Date(o.fetchedAt);
      const written = await tx.insert(insightObservations).values({
        workspace_id: ref.workspaceId, channel_id: ref.channelId, platform: o.platform, metric_key: o.metricKey,
        level: o.level, subject_key: o.subjectKey, grain: o.grain, period: o.period, metric_type: o.metricType,
        window_start: new Date(o.windowStart), window_end: new Date(o.windowEnd), snapshot_day: o.snapshotDay,
        provider_day: o.providerDay, boundary_basis: o.boundaryBasis, fetched_at: fetchedAt, scalar: o.value,
        response_state: o.state, dimensions: o.dimensions, query_params: o.queryParams, transport: o.transport,
        api_version: o.apiVersion, definition_version: o.definitionVersion, coverage_basis: o.coverageBasis, query_key: insightQueryKey(o),
      }).onConflictDoUpdate({
        target: [insightObservations.workspace_id, insightObservations.channel_id, insightObservations.platform, insightObservations.level, insightObservations.subject_key, insightObservations.metric_key, insightObservations.query_key, insightObservations.snapshot_day],
        set: { scalar: o.value, response_state: o.state, fetched_at: fetchedAt, query_params: o.queryParams },
        setWhere: and(eq(insightObservations.workspace_id, ref.workspaceId), sql`${insightObservations.fetched_at} < ${fetchedAt}`),
      }).returning({ id: insightObservations.id });
      count += written.length;
      if (written.length && (!latest || latest < fetchedAt)) latest = fetchedAt;
    }
    if (latest) await tx.update(insightConnections).set({ access_state: "ready", reason: "none",
      last_success_at: sql`greatest(${insightConnections.last_success_at}, ${latest})`,
    }).where(and(eq(insightConnections.workspace_id, ref.workspaceId), eq(insightConnections.channel_id, ref.channelId), eq(insightConnections.credential_revision, revision), eq(insightConnections.collection_mode, "on")));
    return count;
  });
}

export async function pruneInsights(workspaceId: string, now: Date, limit = 1000): Promise<number> {
  if (!Number.isFinite(now.getTime()) || !Number.isInteger(limit) || limit < 1 || limit > 10000) throw new Error("Invalid insights retention request");
  const cutoff = (days: number) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - days * 86400000).toISOString().slice(0, 10);
  const result = await db.execute(sql`DELETE FROM ${insightObservations} WHERE workspace_id = ${workspaceId} AND id IN (
    SELECT id FROM ${insightObservations} WHERE workspace_id = ${workspaceId} AND (
      (grain IN ('day','snapshot') AND snapshot_day < ${cutoff(400)}::date) OR
      (grain = 'range' AND fetched_at < ${new Date(now.getTime() - 7 * 86400000)}) OR
      (grain = 'audience_window' AND snapshot_day < ${cutoff(90)}::date)
    ) ORDER BY snapshot_day, id LIMIT ${limit} FOR UPDATE SKIP LOCKED
  ) RETURNING id`);
  return result.rows.length;
}

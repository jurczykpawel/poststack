import { inArray, lt, sql } from "drizzle-orm";
import { db as defaultDb } from "@/lib/db";
import { webhookEvents, webhookEventStats } from "@/db/schema";

type Executor = typeof defaultDb;

/** UTC wall-clock of a Date for comparing against DB-clock `timestamp without time zone` columns
 *  (mirrors utcCutoff in maintenance.ts — avoids the process-TZ skew bug). */
const utc = (d: Date) => sql`${d.toISOString()}::timestamp`;

export interface CompactOpts {
  now: Date;
  retentionDays: number;
  batchSize: number;
  executor?: Executor;
}

export interface CompactResult { compacted: number; orphansDeleted: number }

/** Fold webhook_events older than the window into webhook_event_stats, then delete the raw rows.
 *  Owned rows (channel_id NOT NULL) are aggregated; orphan rows (NULL) are deleted, never aggregated.
 *  Each batch's aggregate+delete commit atomically → a row is counted exactly once. */
export async function compactWebhookEvents(opts: CompactOpts): Promise<CompactResult> {
  const { now, retentionDays, batchSize } = opts;
  const exec = opts.executor ?? defaultDb;
  if (retentionDays <= 0) return { compacted: 0, orphansDeleted: 0 };
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
  let compacted = 0, orphansDeleted = 0;

  for (;;) {
    const batch = await exec.transaction(async (tx) => {
      const rows = await tx
        .select({
          id: webhookEvents.id,
          channel_id: webhookEvents.channel_id,
          platform: webhookEvents.platform,
          event_type: webhookEvents.event_type,
          handling_status: webhookEvents.handling_status,
          day: sql<string>`to_char(date_trunc('day', ${webhookEvents.received_at}), 'YYYY-MM-DD')`,
        })
        .from(webhookEvents)
        .where(lt(webhookEvents.received_at, utc(cutoff)))
        .orderBy(webhookEvents.received_at)
        .limit(batchSize)
        .for("update", { skipLocked: true });
      if (rows.length === 0) return { n: 0, orphans: 0 };

      const agg = new Map<string, { channel_id: string; day: string; platform: typeof rows[number]["platform"]; event_type: string; handling_status: typeof rows[number]["handling_status"]; count: number }>();
      let orphans = 0;
      for (const r of rows) {
        if (r.channel_id == null) { orphans++; continue; }
        const key = `${r.channel_id}|${r.day}|${r.event_type}|${r.handling_status}`;
        const cur = agg.get(key);
        if (cur) cur.count++;
        else agg.set(key, { channel_id: r.channel_id, day: r.day, platform: r.platform, event_type: r.event_type, handling_status: r.handling_status, count: 1 });
      }
      if (agg.size > 0) {
        await tx.insert(webhookEventStats).values([...agg.values()])
          .onConflictDoUpdate({
            target: [webhookEventStats.channel_id, webhookEventStats.day, webhookEventStats.event_type, webhookEventStats.handling_status],
            set: { count: sql`${webhookEventStats.count} + excluded.count` },
          });
      }
      await tx.delete(webhookEvents).where(inArray(webhookEvents.id, rows.map((r) => r.id)));
      return { n: rows.length - orphans, orphans };
    });
    compacted += batch.n;
    orphansDeleted += batch.orphans;
    if (batch.n + batch.orphans === 0) break;
  }
  return { compacted, orphansDeleted };
}

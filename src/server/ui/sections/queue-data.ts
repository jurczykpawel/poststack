import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { deliveries, channels } from "@/db/schema";
import { platformLabel } from "../components/platform";

type DeliveryRow = typeof deliveries.$inferSelect;
type ChannelRow = typeof channels.$inferSelect;

export interface QueueRow {
  id: string;
  status: DeliveryRow["status"];
  format: string;
  scheduledAt: Date;
  runAt: Date | null;
  attempts: number;
  lastError: string | null;
  platform: string;
  metadata: unknown;
  channelName: string;
}

export interface QueueFilters {
  workspaceId: string;
  limit: number;
  status?: DeliveryRow["status"];
  channelId?: string;
  format?: string;
}

// With no explicit status filter, failures + upcoming work belong at the top; terminal states sink.
const FOREGROUND_RANK = sql`case ${deliveries.status}
  when 'failed' then 0 when 'held' then 1 when 'unknown' then 2
  when 'scheduled' then 3 when 'sending' then 4 else 5 end`;

/** Deliveries joined with their channel for the operational queue view — workspace-scoped. */
export async function listQueue(f: QueueFilters): Promise<QueueRow[]> {
  const filters = [
    eq(deliveries.workspace_id, f.workspaceId),
    f.status ? eq(deliveries.status, f.status) : undefined,
    f.channelId ? eq(deliveries.channel_id, f.channelId) : undefined,
    f.format ? eq(deliveries.format, f.format) : undefined,
  ].filter((x): x is NonNullable<typeof x> => x !== undefined);

  const rows = await db
    .select({
      id: deliveries.id,
      status: deliveries.status,
      format: deliveries.format,
      scheduledAt: deliveries.scheduled_at,
      runAt: deliveries.run_at,
      attempts: deliveries.attempts,
      lastError: deliveries.last_error,
      platform: channels.platform,
      metadata: channels.metadata,
      name: channels.display_name,
      account: channels.platform_id,
    })
    .from(deliveries)
    .innerJoin(channels, eq(deliveries.channel_id, channels.id))
    .where(and(...filters))
    .orderBy(
      ...(f.status ? [] : [asc(FOREGROUND_RANK)]),
      desc(deliveries.scheduled_at),
      desc(deliveries.id),
    )
    .limit(f.limit);

  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    format: r.format,
    scheduledAt: r.scheduledAt,
    runAt: r.runAt,
    attempts: r.attempts,
    lastError: r.lastError,
    platform: r.platform,
    metadata: r.metadata,
    channelName: r.name ?? r.account,
  }));
}

export interface ChannelOption {
  id: string;
  label: string;
}

/** Channels (id + friendly label) for the queue's channel filter dropdown — workspace-scoped. */
export async function channelOptions(workspaceId: string): Promise<ChannelOption[]> {
  const rows = await db
    .select({
      id: channels.id,
      name: channels.display_name,
      account: channels.platform_id,
      platform: channels.platform,
      metadata: channels.metadata,
    })
    .from(channels)
    .where(eq(channels.workspace_id, workspaceId))
    .orderBy(asc(channels.display_name));
  return rows.map((r) => ({
    id: r.id,
    label: r.name ?? `${platformLabel(r.platform, r.metadata)} · ${r.account}`,
  }));
}

export interface QueueItem {
  post: DeliveryRow;
  channel: ChannelRow;
  channelName: string;
}

/** A single delivery plus its channel for the detail page — workspace-scoped (undefined if unknown). */
export async function getQueueItem(workspaceId: string, id: string): Promise<QueueItem | undefined> {
  const post = await db.query.deliveries.findFirst({
    where: and(eq(deliveries.id, id), eq(deliveries.workspace_id, workspaceId)),
  });
  if (!post) return undefined;
  const channel = await db.query.channels.findFirst({
    where: and(eq(channels.id, post.channel_id), eq(channels.workspace_id, workspaceId)),
  });
  if (!channel) return undefined;
  return { post, channel, channelName: channel.display_name ?? channel.platform_id };
}

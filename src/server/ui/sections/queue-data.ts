import { and, asc, count, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { deliveries, channels, posts } from "@/db/schema";
import { containsPattern, listPage, type ListPage } from "@/lib/list-page";
import { platformLabel } from "../components/platform";

type DeliveryRow = typeof deliveries.$inferSelect;
type ChannelRow = typeof channels.$inferSelect;
type Status = DeliveryRow["status"];

export const QUEUE_SECTIONS = {
  scheduled: ["scheduled", "sending", "processing"],
  published: ["sent"],
  canceled: ["canceled"],
  attention: ["failed", "held", "unknown"],
} as const satisfies Record<string, readonly Status[]>;
export type QueueSection = keyof typeof QUEUE_SECTIONS;

export const isQueueSection = (s: string | undefined): s is QueueSection => !!s && Object.hasOwn(QUEUE_SECTIONS, s);

export interface QueueRow {
  id: string;
  tiktokConfirmation: DeliveryRow["tiktok_confirmation"];
  status: Status;
  format: string;
  scheduledAt: Date;
  lastError: string | null;
  text: string | null;
  platform: string;
  metadata: unknown;
  channelName: string;
}

export interface QueueFilters {
  workspaceId: string;
  q?: string;
  channelId?: string;
  format?: string;
}

const ROW_COLUMNS = {
  id: deliveries.id,
  tiktokConfirmation: deliveries.tiktok_confirmation,
  status: deliveries.status,
  format: deliveries.format,
  scheduledAt: deliveries.scheduled_at,
  lastError: deliveries.last_error,
  // Long captions are clipped here so a page of rows never carries whole payloads.
  text: sql<string | null>`left(coalesce(nullif(${deliveries.payload}->>'caption', ''), ${deliveries.payload}->>'title'), 240)`,
  platform: channels.platform,
  metadata: channels.metadata,
  name: channels.display_name,
  account: channels.platform_id,
};

function toRow(r: Omit<QueueRow, "channelName"> & { name: string | null; account: string }): QueueRow {
  return { ...r, channelName: r.name ?? r.account };
}

function filtered(f: QueueFilters): SQL | undefined {
  const pattern = f.q ? containsPattern(f.q) : null;
  return and(
    eq(deliveries.workspace_id, f.workspaceId),
    f.channelId ? eq(deliveries.channel_id, f.channelId) : undefined,
    f.format ? eq(deliveries.format, f.format) : undefined,
    pattern
      ? or(
          sql`${deliveries.payload}->>'caption' ILIKE ${pattern}`,
          sql`${deliveries.channel_id} IN (SELECT ${channels.id} FROM ${channels} WHERE ${channels.workspace_id} = ${f.workspaceId} AND (${channels.display_name} ILIKE ${pattern} OR ${channels.platform_id} ILIKE ${pattern}))`,
        )
      : undefined,
  );
}

const inSection = (s: QueueSection) => inArray(deliveries.status, [...QUEUE_SECTIONS[s]]);
const soonestFirst = (s: QueueSection) => s === "scheduled";

/** The zone's calendar day as a range of the stored UTC timestamps, so the section index still applies. */
function dayRange(day: string, tz: string): SQL {
  const start = (d: SQL) => sql`(${d}::timestamp at time zone ${tz} at time zone 'UTC')`;
  return sql`${deliveries.scheduled_at} >= ${start(sql`${day}::date`)} AND ${deliveries.scheduled_at} < ${start(sql`(${day}::date + 1)`)}`;
}

/** The first rows of one section, independent of how many the other sections hold. */
export async function sectionRows(f: QueueFilters, section: QueueSection, limit: number, day?: { day: string; tz: string }): Promise<QueueRow[]> {
  const order = soonestFirst(section) ? asc : desc;
  const rows = await db.select(ROW_COLUMNS).from(deliveries)
    .innerJoin(channels, eq(deliveries.channel_id, channels.id))
    .where(and(filtered(f), inSection(section), day ? dayRange(day.day, day.tz) : undefined))
    .orderBy(order(deliveries.scheduled_at), order(deliveries.id))
    .limit(limit);
  return rows.map(toRow);
}

/** One section as cursor pages: soonest first for Scheduled, newest first otherwise. */
export async function sectionPage(f: QueueFilters, section: QueueSection, limit: number, after: string, before: string): Promise<ListPage<QueueRow>> {
  return listPage<QueueRow>({
    table: deliveries, where: and(filtered(f), inSection(section)), time: deliveries.scheduled_at, id: deliveries.id,
    ascending: soonestFirst(section), limit, after, before,
    keyOf: (r) => ({ at: r.scheduledAt, id: r.id }),
    fetch: async (q) => (await db.select(ROW_COLUMNS).from(deliveries).innerJoin(channels, eq(deliveries.channel_id, channels.id)).where(q.where).orderBy(...q.orderBy).limit(q.limit)).map(toRow),
  });
}

export interface QueueCounts {
  /** Rows per status under every filter: the section counters and the attention breakdown. */
  byStatus: Map<string, number>;
  /** Formats under the other filters, so the format filter keeps offering its alternatives. */
  formats: string[];
}

/** One pass over the workspace for both the counters and the format filter. */
export async function queueCounts(f: QueueFilters): Promise<QueueCounts> {
  const rows = await db.select({ status: deliveries.status, format: deliveries.format, n: sql<number>`${count()}::int` })
    .from(deliveries).where(filtered({ ...f, format: undefined })).groupBy(deliveries.status, deliveries.format);
  const byStatus = new Map<string, number>();
  for (const r of rows) if (!f.format || r.format === f.format) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + r.n);
  return { byStatus, formats: [...new Set(rows.map((r) => r.format))].sort() };
}

export interface ScheduledDay {
  day: string;
  n: number;
}

/** The nearest days holding scheduled posts, on the viewer's calendar. */
export async function scheduledDays(f: QueueFilters, tz: string, limit: number): Promise<ScheduledDay[]> {
  return db.select({
    day: sql<string>`to_char(${deliveries.scheduled_at} at time zone 'UTC' at time zone ${tz}, 'YYYY-MM-DD')`,
    n: sql<number>`${count()}::int`,
  }).from(deliveries).where(and(filtered(f), inSection("scheduled"))).groupBy(sql`1`).orderBy(sql`1`).limit(limit);
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

/** The editorial post behind a delivery, when there is one: its fields build the published caption. */
export async function linkedPostText(workspaceId: string, deliveryId: string): Promise<{ description: string | null; hashtags: string | null } | undefined> {
  const [row] = await db.select({ description: posts.description, hashtags: posts.hashtags }).from(posts)
    .where(and(eq(posts.workspace_id, workspaceId), eq(posts.delivery_id, deliveryId))).orderBy(posts.id).limit(1);
  return row;
}

const knownZones = new Map<string, boolean>();

/** The viewer's IANA zone when both the runtime and the database know it; otherwise UTC. */
export async function resolveZone(candidate: string | undefined): Promise<string> {
  if (!candidate || !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(candidate)) return "UTC";
  let known = knownZones.get(candidate);
  if (known === undefined) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: candidate });
      await db.execute(sql`select now() at time zone ${candidate}`);
      known = true;
    } catch {
      known = false;
    }
    if (knownZones.size < 1000) knownZones.set(candidate, known);
  }
  return known ? candidate : "UTC";
}

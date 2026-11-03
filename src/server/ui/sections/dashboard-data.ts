import { and, asc, count, desc, eq, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels, accountSources, deliveries, events } from "@/db/schema";
import { QUEUE_SECTIONS } from "./queue-data";
import { platformLabel } from "../components/platform";
import { reconnectHref } from "../components/reconnect";
import type { Tone } from "../components/status";

const WARN_DAYS = Math.max(1, Number(process.env.SOURCE_DATA_ACCESS_WARN_DAYS ?? 7) || 7);
const MAX_ITEMS = 8;

export interface AttentionAction {
  label: string;
  href: string;
  variant: "primary" | "secondary";
}
export interface AttentionItem {
  kind: "channel" | "source" | "post";
  platform?: string;
  metadata?: unknown;
  title: string;
  tone: Tone;
  reason: string;
  action: Omit<AttentionAction, "variant">;
  /** Where clicking the row lands — the entity's detail/management view. Undefined → row not linked. */
  detailHref?: string;
}
export interface AttentionRow extends Omit<AttentionItem, "action"> {
  action: AttentionAction;
}

const TONE_RANK: Record<Tone, number> = { bad: 0, warn: 1, neutral: 2, info: 3, ok: 4 };

/** Everything in a workspace that needs a human: broken/paused channels, sources at the data-access
 *  wall or dead, and recently-failed deliveries. Urgency-sorted, capped; the top row is primary. */
export async function gatherAttention(workspaceId: string): Promise<AttentionRow[]> {
  const items: AttentionItem[] = [];

  const chans = await db.query.channels.findMany({
    where: and(
      eq(channels.workspace_id, workspaceId),
      isNull(channels.deleted_at),
      isNull(channels.hidden_at), // hidden channels are intentionally parked — don't nag about them
      or(eq(channels.status, "needs_reauth"), eq(channels.status, "paused")),
    ),
    orderBy: [desc(channels.updated_at)],
    limit: MAX_ITEMS,
  });
  for (const ch of chans) {
    const name = ch.display_name ?? ch.platform_id;
    const detailHref = `/channels/${ch.id}`;
    if (ch.status === "needs_reauth") {
      items.push({ kind: "channel", platform: ch.platform, metadata: ch.metadata, title: name, tone: "warn", reason: ch.needs_reauth_reason ?? "Token needs reauthorization", action: { label: "Reconnect", href: reconnectHref(ch) }, detailHref });
    } else {
      items.push({ kind: "channel", platform: ch.platform, metadata: ch.metadata, title: name, tone: "neutral", reason: "Paused — not publishing", action: { label: "Resume", href: "/channels" }, detailHref });
    }
  }

  const wall = new Date(Date.now() + WARN_DAYS * 86400000);
  const srcs = await db.query.accountSources.findMany({
    where: and(
      eq(accountSources.workspace_id, workspaceId),
      ne(accountSources.status, "disabled"),
      or(
        eq(accountSources.status, "needs_reauth"),
        and(isNotNull(accountSources.data_access_expires_at), lte(accountSources.data_access_expires_at, wall)),
      ),
    ),
    orderBy: [desc(accountSources.updated_at)],
    limit: MAX_ITEMS,
  });
  for (const s of srcs) {
    const name = s.display_name ?? s.provider_account_id;
    const bad = s.status === "needs_reauth";
    items.push({
      kind: "source",
      platform: s.provider,
      title: `${platformLabel(s.provider)} master · ${name}`,
      tone: bad ? "bad" : "warn",
      reason: bad ? (s.needs_reauth_reason ?? "Master token invalid") : "Data-access window closing",
      action: { label: "Reconnect master", href: "/sources" },
      detailHref: "/sources",
    });
  }

  const failed = await db
    .select({
      platform: channels.platform,
      metadata: channels.metadata,
      name: channels.display_name,
      account: channels.platform_id,
      lastError: deliveries.last_error,
      attempts: deliveries.attempts,
      status: deliveries.status,
    })
    .from(deliveries)
    .innerJoin(channels, eq(deliveries.channel_id, channels.id))
    .where(and(
      eq(deliveries.workspace_id, workspaceId),
      inArray(deliveries.status, [...QUEUE_SECTIONS.attention]), // same statuses as Queue's "Needs attention", any age
      isNull(channels.deleted_at),
    ))
    .orderBy(desc(deliveries.updated_at))
    .limit(MAX_ITEMS);
  for (const p of failed) {
    const detail = p.lastError ? p.lastError : `${p.status}${p.attempts ? ` · attempt ${p.attempts}` : ""}`;
    items.push({ kind: "post", platform: p.platform, metadata: p.metadata, title: p.name ?? p.account, tone: p.status === "failed" ? "bad" : "warn", reason: detail, action: { label: "Review", href: "/queue?status=attention" }, detailHref: "/queue?status=attention" });
  }

  items.sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone]);
  return items.slice(0, MAX_ITEMS).map((it, i) => ({ ...it, action: { ...it.action, variant: i === 0 ? "primary" : "secondary" } }));
}

/** How many attention rows exist in total (the list is capped at MAX_ITEMS): the shown rows plus the
 *  failed/unknown posts beyond the cap — the same statuses Queue's "Needs attention" counts. */
export async function attentionTotal(workspaceId: string, shown: AttentionRow[]): Promise<number> {
  const [{ n }] = await db
    .select({ n: count() })
    .from(deliveries)
    .innerJoin(channels, eq(deliveries.channel_id, channels.id))
    .where(and(eq(deliveries.workspace_id, workspaceId), inArray(deliveries.status, [...QUEUE_SECTIONS.attention]), isNull(channels.deleted_at)));
  return shown.length + Math.max(0, n - shown.filter((a) => a.kind === "post").length);
}

export interface UpcomingPost {
  scheduledAt: Date;
  format: string;
  platform: string;
  metadata: unknown;
  channelName: string;
}

/** The next `limit` future scheduled deliveries (soonest first), workspace-scoped. */
export async function upcomingScheduled(workspaceId: string, limit: number): Promise<UpcomingPost[]> {
  const rows = await db
    .select({
      scheduledAt: deliveries.scheduled_at,
      format: deliveries.format,
      platform: channels.platform,
      metadata: channels.metadata,
      name: channels.display_name,
      account: channels.platform_id,
    })
    .from(deliveries)
    .innerJoin(channels, eq(deliveries.channel_id, channels.id))
    .where(and(
      eq(deliveries.workspace_id, workspaceId),
      eq(deliveries.status, "scheduled"),
      isNull(channels.deleted_at),
      sql`${deliveries.scheduled_at} >= now()`,
    ))
    .orderBy(asc(deliveries.scheduled_at))
    .limit(limit);
  return rows.map((r) => ({ scheduledAt: r.scheduledAt, format: r.format, platform: r.platform, metadata: r.metadata, channelName: r.name ?? r.account }));
}

export interface RecentEvent {
  type: string;
  createdAt: Date;
}

/** The most recent workspace events for the activity feed. */
export async function recentEvents(workspaceId: string, limit: number): Promise<RecentEvent[]> {
  const rows = await db.query.events.findMany({
    where: eq(events.workspace_id, workspaceId),
    orderBy: [desc(events.created_at)],
    limit,
    columns: { type: true, created_at: true },
  });
  return rows.map((r) => ({ type: r.type, createdAt: r.created_at }));
}

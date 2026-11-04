// The FREE-tier overview. Free keeps unlimited message *handling* (the bot answers
// everyone), but the human-facing inbox/CRM — seeing WHO you talked to — is PRO. So
// free instead gets aggregate counters plus a thin recent-sends log that carries NO
// client identity: type, channel, status and time only. Never contact_id, username,
// PSID, or message text. The numbers come from `outbound_deliveries`; a bare contact
// COUNT is just a number, not a person, so it stays free too.

import { count, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels, contacts, deliveries, outboundDeliveries } from "@/db/schema";

// Outbound task name -> a friendly, identity-free label for the activity log.
const TASK_LABELS: Record<string, string> = {
  "outgoing-message": "DM",
  "outgoing-comment": "Comment reply",
  "outgoing-private-reply": "Private reply",
  "follow-gate": "Follow-gate",
  "sequence-step": "Sequence step",
};

/** Friendly label for an outbound delivery's task name; unknown names degrade to a generic one. */
export function deliveryLabel(taskName: string): string {
  return TASK_LABELS[taskName] ?? "Message";
}

export interface RecentSend {
  id: string;
  label: string;
  platform: string | null;
  status: string;
  createdAt: Date;
}

export interface Overview {
  total: number;
  sent: number;
  failed: number;
  held: number;
  today: number;
  contactCount: number;
  /** Queue posts (`deliveries`) that need a human — the same statuses Queue's "Needs attention" lists. */
  posts: { failed: number; held: number; unknown: number };
  recentSends: RecentSend[];
}

/** Calendar-day predicate for dashboard counters and their linked activity list. */
export function inViewerDay(at: typeof outboundDeliveries.created_at, now: Date, timeZone = "UTC") {
  const local = sql`date_trunc('day', ${now.toISOString()}::timestamptz at time zone ${timeZone})`;
  const start = sql`(${local} at time zone ${timeZone} at time zone 'UTC')`;
  const end = sql`((${local} + interval '1 day') at time zone ${timeZone} at time zone 'UTC')`;
  return sql`${at} >= ${start} and ${at} < ${end}`;
}

/**
 * Aggregate overview for a workspace. Reads only counts + identity-free delivery
 * metadata, so it is safe to serve on the free tier.
 */
export async function loadOverview(
  workspaceId: string,
  opts: { now?: Date; logLimit?: number; timeZone?: string } = {},
): Promise<Overview> {
  const now = opts.now ?? new Date();
  const logLimit = opts.logLimit ?? 20;
  const today = inViewerDay(outboundDeliveries.created_at, now, opts.timeZone);

  const isStatus = (s: string) => sql<number>`count(*) filter (where ${outboundDeliveries.status} = ${s})`;

  const [agg] = await db
    .select({
      total: count(),
      sent: isStatus("sent"),
      failed: isStatus("failed"),
      held: isStatus("held"),
      today: sql<number>`count(*) filter (where ${outboundDeliveries.status} = 'sent' and ${today})`,
    })
    .from(outboundDeliveries)
    .where(eq(outboundDeliveries.workspace_id, workspaceId));

  const [contactAgg] = await db
    .select({ n: count() })
    .from(contacts)
    .where(eq(contacts.workspace_id, workspaceId));

  const [postAgg] = await db
    .select({
      failed: sql<number>`count(*) filter (where ${deliveries.status} = 'failed')`,
      held: sql<number>`count(*) filter (where ${deliveries.status} = 'held')`,
      unknown: sql<number>`count(*) filter (where ${deliveries.status} = 'unknown')`,
    })
    .from(deliveries)
    .where(eq(deliveries.workspace_id, workspaceId));

  // Identity-free: id, task_name, status, channel platform, created_at. Never contact_id/payload.
  const rows = await db
    .select({
      id: outboundDeliveries.id,
      taskName: outboundDeliveries.task_name,
      status: outboundDeliveries.status,
      platform: channels.platform,
      createdAt: outboundDeliveries.created_at,
    })
    .from(outboundDeliveries)
    .leftJoin(channels, eq(channels.id, outboundDeliveries.channel_id))
    .where(eq(outboundDeliveries.workspace_id, workspaceId))
    .orderBy(desc(outboundDeliveries.created_at))
    .limit(logLimit);

  return {
    total: Number(agg?.total ?? 0),
    sent: Number(agg?.sent ?? 0),
    failed: Number(agg?.failed ?? 0),
    held: Number(agg?.held ?? 0),
    today: Number(agg?.today ?? 0),
    contactCount: Number(contactAgg?.n ?? 0),
    posts: { failed: Number(postAgg?.failed ?? 0), held: Number(postAgg?.held ?? 0), unknown: Number(postAgg?.unknown ?? 0) },
    recentSends: rows.map((r) => ({
      id: r.id,
      label: deliveryLabel(r.taskName),
      platform: r.platform,
      status: r.status,
      createdAt: r.createdAt,
    })),
  };
}

// The FREE-tier overview. Free keeps unlimited message *handling* (the bot answers
// everyone), but the human-facing inbox/CRM — seeing WHO you talked to — is PRO. So
// free instead gets aggregate counters plus a thin recent-sends log that carries NO
// client identity: type, channel, status and time only. Never contact_id, username,
// PSID, or message text. The numbers come from `outbound_deliveries`; a bare contact
// COUNT is just a number, not a person, so it stays free too.

import { count, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels, contacts, outboundDeliveries } from "@/db/schema";

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
  recentSends: RecentSend[];
}

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Aggregate overview for a workspace. Reads only counts + identity-free delivery
 * metadata, so it is safe to serve on the free tier.
 */
export async function loadOverview(
  workspaceId: string,
  opts: { now?: Date; logLimit?: number } = {},
): Promise<Overview> {
  const now = opts.now ?? new Date();
  const logLimit = opts.logLimit ?? 20;
  const dayStart = startOfUtcDay(now);

  const isStatus = (s: string) => sql<number>`count(*) filter (where ${outboundDeliveries.status} = ${s})`;

  const [agg] = await db
    .select({
      total: count(),
      sent: isStatus("sent"),
      failed: isStatus("failed"),
      held: isStatus("held"),
      today: sql<number>`count(*) filter (where ${outboundDeliveries.created_at} >= ${dayStart})`,
    })
    .from(outboundDeliveries)
    .where(eq(outboundDeliveries.workspace_id, workspaceId));

  const [contactAgg] = await db
    .select({ n: count() })
    .from(contacts)
    .where(eq(contacts.workspace_id, workspaceId));

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
    recentSends: rows.map((r) => ({
      id: r.id,
      label: deliveryLabel(r.taskName),
      platform: r.platform,
      status: r.status,
      createdAt: r.createdAt,
    })),
  };
}

import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels, deliveries, outboundDeliveries } from "@/db/schema";
import type { PublishRequest } from "@/lib/providers/types";
import { firstCommentEligibility } from "@/lib/deliveries/first-comment";
import { redactSecrets } from "@/lib/redact";
import type { PostRow } from "./service";

const errorText = (error: string | null) => error === null ? null : redactSecrets(error);

/** Load both ledgers once per page, including workspace scope on every table. */
export async function withPostDeliveries<T extends Pick<PostRow, "delivery_id">>(rows: T[], workspaceId: string) {
  const ids = rows.flatMap((row) => row.delivery_id ? [row.delivery_id] : []);
  const linked = ids.length ? await db.select({
    delivery: deliveries,
    channel: { platform: channels.platform, default_first_comment: channels.default_first_comment },
  }).from(deliveries).innerJoin(channels, and(
    eq(deliveries.channel_id, channels.id), eq(channels.workspace_id, workspaceId),
  )).where(and(eq(deliveries.workspace_id, workspaceId), inArray(deliveries.id, ids))) : [];
  const comments = linked.length ? await db.select({
    deliveryKey: outboundDeliveries.delivery_key,
    status: outboundDeliveries.status,
    commentId: outboundDeliveries.platform_message_id,
    attempts: outboundDeliveries.attempts,
    lastError: outboundDeliveries.last_error,
  }).from(outboundDeliveries).where(and(
    eq(outboundDeliveries.workspace_id, workspaceId),
    inArray(outboundDeliveries.delivery_key, linked.map(({ delivery }) => `first-comment:${delivery.id}`)),
  )) : [];
  const byKey = new Map(comments.map((row) => [row.deliveryKey, row]));
  const byId = new Map(await Promise.all(linked.map(async ({ delivery: d, channel }) => {
    const comment = byKey.get(`first-comment:${d.id}`);
    // No row means eligibility is evaluated NOW, not recorded at publication.
    // A sent, eligible delivery may still be waiting for its first-comment worker; no skip reason then.
    const reason = comment ? undefined : d.status !== "sent" ? "awaiting_publish"
      : (await firstCommentEligibility(channel, d.payload as PublishRequest)).reason;
    return [d.id, {
      id: d.id,
      channelId: d.channel_id,
      status: d.status,
      scheduledFor: d.scheduled_at.toISOString(),
      attempts: d.attempts,
      lastError: errorText(d.last_error),
      platformPostId: d.provider_handle,
      updatedAt: d.updated_at.toISOString(),
      firstComment: {
        status: comment?.status ?? "not_attempted",
        ...(reason ? { reason } : {}),
        commentId: comment?.commentId ?? null,
        attempts: comment?.attempts ?? 0,
        lastError: errorText(comment?.lastError ?? null),
      },
    }] as const;
  })));
  return rows.map((row) => ({ ...row, delivery: row.delivery_id ? byId.get(row.delivery_id) ?? null : null }));
}

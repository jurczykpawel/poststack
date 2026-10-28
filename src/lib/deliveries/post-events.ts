import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels, deliveries, posts } from "@/db/schema";
import { emitEvent } from "@/lib/events";
import { withPostDeliveries } from "@/lib/content/post-delivery";

/** Snapshot the publication context when emitting, retaining the editorial subject id. */
export async function emitPostEvent(
  workspaceId: string,
  type: string,
  deliveryId: string,
  payload: Record<string, unknown>,
  tx: Parameters<typeof emitEvent>[0] = db,
): Promise<void> {
  const [linked] = await db.select({ delivery: deliveries, platform: channels.platform })
    .from(deliveries).innerJoin(channels, and(eq(channels.id, deliveries.channel_id), eq(channels.workspace_id, workspaceId)))
    .where(and(eq(deliveries.id, deliveryId), eq(deliveries.workspace_id, workspaceId)));
  if (!linked) return;
  const editorial = await db.query.posts.findFirst({
    where: and(eq(posts.delivery_id, deliveryId), eq(posts.workspace_id, workspaceId)),
    columns: { id: true, published_at: true },
  });
  const [detail] = type === "post.published" ? await withPostDeliveries([{ delivery_id: deliveryId }], workspaceId) : [];
  await emitEvent(tx, workspaceId, type, { type: "post", id: editorial?.id ?? deliveryId }, {
    ...payload,
    workspaceId,
    channelId: linked.delivery.channel_id,
    platform: linked.platform,
    status: linked.delivery.status === "sent" ? "published" : linked.delivery.status,
    deliveryId,
    ...(type === "post.failed" ? { reason: payload.error } : {}),
    ...(type === "post.published" ? {
      publishedAt: editorial?.published_at?.toISOString() ?? linked.delivery.updated_at.toISOString(),
      firstComment: detail?.delivery?.firstComment ?? { status: "not_attempted", commentId: null },
    } : {}),
  });
}

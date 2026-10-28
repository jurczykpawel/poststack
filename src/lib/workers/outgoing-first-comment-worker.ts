import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { outboundDeliveries } from "@/db/schema";
import { emitPostEvent } from "@/lib/deliveries/post-events";
import { redactSecrets } from "@/lib/redact";
import type { JobHelpers } from "graphile-worker";
import type { OutgoingFirstCommentJob } from "@/lib/queue/types";
import { decryptChannelToken } from "@/lib/channels/tokens";
import { getProvider } from "@/lib/platforms/registry";
import { runDelivery, type DeliveryChannel } from "./delivery";

/**
 * FIRSTCOMMENT1: post the configured "first comment" as a NEW top-level comment under a
 * just-published post, through the durable delivery state machine (see {@link runDelivery}) so a
 * crash cannot silently double-post.
 *
 * Best-effort by design: enqueued separately from the publish, with its own delivery key, so a
 * failure here never affects the published post. The deterministic key is set by the enqueuer to the
 * delivery id, making a re-published/retried post reuse the same ledger row instead of double-posting.
 */
export async function processOutgoingFirstComment(
  payload: OutgoingFirstCommentJob,
  helpers: JobHelpers,
): Promise<void> {
  const { channelId, postId, text, idempotencyKey } = payload;

  const deliveryKey = idempotencyKey ?? `job:${helpers.job.id}`;
  const publishDeliveryId = deliveryKey.startsWith("first-comment:") ? deliveryKey.slice("first-comment:".length) : null;
  let workspaceId: string | undefined;
  const notifyFailure = async () => {
    if (!publishDeliveryId || !workspaceId) return;
    const ledger = await db.query.outboundDeliveries.findFirst({ where: and(
      eq(outboundDeliveries.delivery_key, deliveryKey), eq(outboundDeliveries.workspace_id, workspaceId),
    ) });
    if (ledger && ["failed", "expired"].includes(ledger.status)) await emitPostEvent(workspaceId, "post.first_comment", publishDeliveryId, {
      providerHandle: postId, firstComment: { status: "failed", commentId: null, reason: redactSecrets(ledger.last_error ?? "Comment failed") },
    });
  };
  try {
    const result = await runDelivery({
      deliveryKey,
      channelId,
      taskName: "outgoing-first-comment",
      payload: payload as unknown as Record<string, unknown>,
      helpers,
      send: async (channel: DeliveryChannel) => {
        workspaceId = channel.workspace_id;
        const tokens = decryptChannelToken(channel.token_encrypted);
        const provider = getProvider(channel.platform);
        if (!provider.commentOnPost) {
          throw new Error(`Platform ${channel.platform} cannot post a comment on a post`);
        }
        const sent = await provider.commentOnPost(tokens, postId, text);
        return { platformMessageId: sent.platformMessageId };
      },
      onSent: async (tx, commentId) => {
        if (!publishDeliveryId || !workspaceId) return;
        await emitPostEvent(workspaceId, "post.first_comment", publishDeliveryId, {
          providerHandle: postId, firstComment: { status: "sent", commentId, reason: null },
        }, tx);
      },
    });
    if (result === "dropped_policy") await notifyFailure();
  } catch (err) {
    // Transient attempts will retry; notify only when the queue has exhausted its budget.
    if ((helpers.job?.attempts ?? 1) >= (helpers.job?.max_attempts ?? 8)) await notifyFailure();
    throw err;
  }

  helpers.logger.info(`first comment processed for post=${postId} channel=${channelId}`);
}

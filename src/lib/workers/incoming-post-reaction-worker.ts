import type { JobHelpers } from "graphile-worker";
import type { IncomingPostReactionJob } from "@/lib/queue/types";
import { and, eq, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels, postReactions, type Platform } from "@/db/schema";
import { markEventStatus } from "@/lib/idempotency";
import { sanitizeForLog } from "@/lib/api/safe-log";

/**
 * Record (or remove) a reaction/like left on one of our posts. Unlike a DM reaction this is
 * pure visibility — no contact is created and no reply is sent. Idempotent: an add upserts the
 * unique (channel, post, reactor) row, a remove deletes it, so a redelivery is a no-op.
 */
export async function processIncomingPostReaction(
  payload: IncomingPostReactionJob,
  helpers: JobHelpers,
): Promise<void> {
  const { platform, pageId, postId, reactorId, reactorName, reactionType, verb } = payload;

  const channel = await db.query.channels.findFirst({
    where: and(
      eq(channels.platform_id, pageId),
      eq(channels.platform, platform as Platform),
      ne(channels.status, "disabled"),
    ),
    columns: { id: true, workspace_id: true },
  });
  if (!channel) {
    helpers.logger.info(`No active channel for pageId=${sanitizeForLog(pageId)}, skipping post reaction`);
    return;
  }

  if (verb === "remove") {
    await db
      .delete(postReactions)
      .where(and(
        eq(postReactions.channel_id, channel.id),
        eq(postReactions.post_id, postId),
        eq(postReactions.reactor_id, reactorId),
      ));
  } else {
    await db
      .insert(postReactions)
      .values({
        workspace_id: channel.workspace_id,
        channel_id: channel.id,
        post_id: postId,
        reactor_id: reactorId,
        reactor_name: reactorName ?? null,
        reaction_type: reactionType,
      })
      .onConflictDoUpdate({
        target: [postReactions.channel_id, postReactions.post_id, postReactions.reactor_id],
        set: { reaction_type: reactionType, reactor_name: reactorName ?? null, updated_at: new Date() },
      });
  }

  if (payload.eventKey) await markEventStatus(payload.eventKey, "fired");
}

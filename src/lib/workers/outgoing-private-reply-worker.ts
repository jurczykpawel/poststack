import type { JobHelpers } from "graphile-worker";
import type { OutgoingPrivateReplyJob } from "@/lib/queue/types";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels, messages, conversations } from "@/db/schema";
import { isClaimed, claim } from "@/lib/idempotency";
import { decryptTokens } from "@/lib/crypto";
import { getProvider } from "@/lib/platforms/registry";
import { TokenInvalidError } from "@/lib/platforms/errors";
import { markChannelNeedsReauth } from "@/lib/channels/health";

/**
 * Send a private reply to a comment (comment-to-DM, addressed by comment_id).
 * Works for first-touch commenters who have never messaged the page.
 * Idempotency key is claimed AFTER a successful send so retries are not blocked.
 */
export async function processOutgoingPrivateReply(
  payload: OutgoingPrivateReplyJob,
  helpers: JobHelpers,
): Promise<void> {
  const { channelId, conversationId, commentId, text, content, sentByRuleId, idempotencyKey } = payload;
  const messageContent = content ?? { text };

  const persist = (status: "sent" | "held" | "failed", platformMessageId: string | null = null) =>
    db.insert(messages).values({
      conversation_id: conversationId,
      direction: "outbound",
      text,
      status,
      platform_message_id: platformMessageId,
      sent_by_rule_id: sentByRuleId ?? null,
    });

  if (idempotencyKey && (await isClaimed(idempotencyKey))) {
    helpers.logger.info(`Idempotency key already claimed, skipping private reply`);
    return;
  }

  const channel = await db.query.channels.findFirst({
    where: eq(channels.id, channelId),
    columns: { id: true, platform: true, token_encrypted: true, status: true },
  });

  if (!channel || channel.status === "disabled") {
    throw new Error(`Channel ${channelId} not found or disabled`);
  }

  if (channel.status === "needs_reauth") {
    await persist("held");
    helpers.logger.info(`Channel ${channelId} needs_reauth, private reply held`);
    return;
  }

  const tokens = decryptTokens(channel.token_encrypted);
  const provider = getProvider(channel.platform);
  if (!provider.sendPrivateReply) {
    throw new Error(`Platform ${channel.platform} does not support private replies`);
  }

  try {
    await provider.sendPrivateReply(tokens, commentId, messageContent);
  } catch (e) {
    if (e instanceof TokenInvalidError) {
      await persist("held");
      await markChannelNeedsReauth(channelId, e.message);
      helpers.logger.info(`Channel ${channelId} token invalid on private reply, held + needs_reauth`);
      return;
    }
    await persist("failed");
    throw e;
  }

  if (idempotencyKey) {
    await claim(idempotencyKey);
  }

  await persist("sent");
  await db
    .update(conversations)
    .set({ last_message_at: new Date(), last_message_preview: text.slice(0, 255) })
    .where(eq(conversations.id, conversationId));

  helpers.logger.info(`private reply sent for comment=${commentId}`);
}

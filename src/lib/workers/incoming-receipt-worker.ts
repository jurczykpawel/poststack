import type { JobHelpers } from "graphile-worker";
import { and, eq, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import type { IncomingReceiptJob } from "@/lib/queue/types";
import { db } from "@/lib/db";
import { channels, contactChannels, conversations, messages } from "@/db/schema";
import { sanitizeForLog } from "@/lib/api/safe-log";

/**
 * THREADSYNC1: apply a Messenger delivery/read receipt to our OUTBOUND messages, so the thread can
 * show ✓✓ Delivered / Seen. A receipt names the user (sender) and a `watermark` (everything up to it
 * is delivered/read); a delivery receipt may also name specific `mids`. A read receipt implies
 * delivered. Idempotent: only stamps rows not already stamped, so a redelivery is a no-op.
 */
export async function processIncomingReceipt(payload: IncomingReceiptJob, helpers: JobHelpers): Promise<void> {
  const { platform, pageId, userId, kind, watermark, mids } = payload;

  const channel = await db.query.channels.findFirst({
    where: and(
      eq(channels.platform_id, pageId),
      eq(channels.platform, platform as typeof channels.platform.enumValues[number]),
      ne(channels.status, "disabled"),
    ),
    columns: { id: true },
  });
  if (!channel) return;

  // The receipt is from the user who received/read our messages → find their DM conversation.
  const cc = await db.query.contactChannels.findFirst({
    where: and(eq(contactChannels.channel_id, channel.id), eq(contactChannels.platform_sender_id, userId)),
    columns: { contact_id: true },
  });
  if (!cc) return; // we have no thread with this user

  const conv = await db.query.conversations.findFirst({
    where: and(
      eq(conversations.channel_id, channel.id),
      eq(conversations.contact_id, cc.contact_id),
      eq(conversations.thread_type, "dm"),
      eq(conversations.thread_ref, ""),
    ),
    columns: { id: true },
  });
  if (!conv) return;

  // Which outbound messages this receipt covers: explicit mids (delivery) or everything ≤ watermark.
  const scope = mids?.length
    ? inArray(messages.platform_message_id, mids)
    : watermark
      ? lte(messages.created_at, new Date(watermark))
      : null;
  if (!scope) return;

  const now = new Date();
  const target = and(eq(messages.conversation_id, conv.id), eq(messages.direction, "outbound"), scope);

  if (kind === "read") {
    // A read message was necessarily delivered → backfill delivered_at too.
    await db
      .update(messages)
      .set({ read_at: now, delivered_at: sql`coalesce(${messages.delivered_at}, ${now})` })
      .where(and(target, isNull(messages.read_at)));
  } else {
    await db
      .update(messages)
      .set({ delivered_at: now })
      .where(and(target, isNull(messages.delivered_at)));
  }

  helpers.logger.info(`receipt ${kind} applied channel=${channel.id} conversation=${conv.id} user=${sanitizeForLog(userId)}`);
}

import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels, type Platform } from "@/db/schema";
import { getProvider } from "@/lib/platforms/registry";
import type { EmailProvider } from "@/lib/platforms/email";
import { addJob } from "@/lib/queue/client";
import { sanitizeForLog } from "@/lib/api/safe-log";

const EMAIL_PLATFORMS: Platform[] = ["gmail"];

/**
 * Poll one email channel: list new messages since the stored cursor, fetch each, and enqueue an
 * `incoming-message` job (email-typed thread) for the inbound worker. The cursor (max internalDate)
 * is persisted on the channel after a non-empty batch so the next poll resumes after it. Dedup is
 * guaranteed downstream by the unique (conversation_id, platform_message_id) on messages.
 */
export async function pollEmailChannel(channelId: string): Promise<{ ingested: number; cursor: string }> {
  const ch = await db.query.channels.findFirst({
    where: eq(channels.id, channelId),
    columns: { id: true, platform: true, platform_id: true, gmail_query: true, gmail_sync_cursor: true, token_encrypted: true, workspace_id: true },
  });
  if (!ch) return { ingested: 0, cursor: "" };

  // First poll after connect: establish a forward-only baseline (cursor = now) and ingest nothing
  // historical — a freshly connected mailbox must not backfill its existing inbox.
  if (!ch.gmail_sync_cursor) {
    const baseline = String(Date.now());
    await db.update(channels).set({ gmail_sync_cursor: baseline }).where(eq(channels.id, ch.id));
    return { ingested: 0, cursor: baseline };
  }

  const provider = getProvider(ch.platform) as EmailProvider;
  const ids = await provider.listNewMessages(ch, ch.gmail_sync_cursor);

  const account = provider.canonicalizeAddress(ch.platform_id);
  let maxDate = Number(ch.gmail_sync_cursor ?? 0);
  let ingested = 0;
  for (const id of ids) {
    const m = await provider.fetchMessage(ch, id);
    if (m.internalDate > maxDate) maxDate = m.internalDate;
    // Skip the mailbox's own sent messages: a broad filter (or a thread query) also matches the Sent
    // copy of our replies; ingesting those as inbound would echo into the inbox and could loop auto-replies.
    if (provider.canonicalizeAddress(m.fromEmail) === account) continue;
    await addJob("incoming-message", {
      platform: "gmail",
      channelId: ch.id,
      pageId: ch.platform_id,
      senderId: provider.canonicalizeAddress(m.fromEmail),
      recipientId: ch.platform_id,
      mid: m.messageId,
      text: m.text,
      timestamp: m.internalDate,
      threadType: "email",
      threadId: m.threadId,
      subject: m.subject,
    });
    ingested++;
  }

  // Advance the cursor whenever we fetched anything (even if all were self-sent / skipped), so the next
  // poll resumes after them instead of re-scanning the same messages forever.
  if (ids.length) {
    await db.update(channels).set({ gmail_sync_cursor: String(maxDate) }).where(eq(channels.id, ch.id));
  }
  return { ingested, cursor: String(maxDate) };
}

/** Poll every active email channel (the scheduled sweep). Each channel is isolated. */
export async function sweepEmailChannels(): Promise<{ channels: number; ingested: number }> {
  const rows = await db.query.channels.findMany({
    where: and(
      inArray(channels.platform, EMAIL_PLATFORMS),
      eq(channels.status, "active"),
      isNull(channels.deleted_at),
    ),
    columns: { id: true },
  });
  let ingested = 0;
  for (const { id } of rows) {
    try {
      ingested += (await pollEmailChannel(id)).ingested;
    } catch (err) {
      console.error(`[email-poll-sweep] channel ${id}: ${sanitizeForLog(err instanceof Error ? err.message : String(err))}`);
    }
  }
  return { channels: rows.length, ingested };
}

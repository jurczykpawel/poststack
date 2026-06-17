import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels, commentLogs, contacts, conversations } from "@/db/schema";
import { getConfig } from "@/lib/settings/config";
import { encryptTokens, decryptTokens } from "@/lib/crypto";
import { truncateCodePoints } from "@/lib/text";
import { resolveContactConversation } from "@/lib/workers/resolve-contact";
import { evaluateRules } from "@/lib/rules/executor";
import { markChannelNeedsReauth } from "@/lib/channels/health";
import { sanitizeForLog } from "@/lib/api/safe-log";
import { pollCommentThreads, refreshGoogleAccessToken, YouTubeApiError, type YtComment } from "./client";

interface PollCursor {
  etag: string | null;
  sincePublishedAt: string | null;
}

function parseCursor(raw: string | null): PollCursor {
  if (!raw) return { etag: null, sincePublishedAt: null };
  try {
    const v = JSON.parse(raw) as Partial<PollCursor>;
    return { etag: v.etag ?? null, sincePublishedAt: v.sincePublishedAt ?? null };
  } catch {
    return { etag: null, sincePublishedAt: null }; // legacy/garbage cursor → start fresh
  }
}

function laterIso(a: string | null, b: string): string {
  return a && Date.parse(a) >= Date.parse(b) ? a : b;
}

type YtChannel = {
  id: string;
  workspace_id: string;
  status: string;
  platform_id: string;
  token_encrypted: string;
  last_comment_cursor: string | null;
};

/**
 * Return a valid Google access token for the channel, refreshing (and persisting) it when the stored
 * one is within 2 min of expiry. Exported so the reply path can mint a fresh token at send time too —
 * Google access tokens live ~1h, far shorter than the poll/reply cadence.
 */
export async function freshYouTubeAccessToken(channel: { id: string; token_encrypted: string }): Promise<string> {
  const tokens = decryptTokens(channel.token_encrypted);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = typeof tokens.expires_at === "number" ? tokens.expires_at : 0;
  if (tokens.access_token && expiresAt > now + 120) return tokens.access_token;

  const refreshToken = typeof tokens.refresh_token === "string" ? tokens.refresh_token : "";
  if (!refreshToken) throw new YouTubeApiError(401, "No refresh token stored — reconnect the YouTube channel");
  const { accessToken, expiresAt: newExp } = await refreshGoogleAccessToken({
    refreshToken,
    clientId: await getConfig("GOOGLE_CLIENT_ID"),
    clientSecret: await getConfig("GOOGLE_CLIENT_SECRET"),
  });
  await db
    .update(channels)
    .set({ token_encrypted: encryptTokens({ ...tokens, access_token: accessToken, expires_at: newExp }) })
    .where(eq(channels.id, channel.id));
  return accessToken;
}

/** Ingest one new comment: link a contact + per-video comment thread, log it (dedup), and run rules.
 *  Returns false if the comment was already logged (dedup) so the caller doesn't double-count. */
async function ingestComment(channel: YtChannel, c: YtComment): Promise<boolean> {
  if (!c.authorChannelId) return false; // can't resolve a contact without an author

  const { contactId, conversationId, isAutomationPaused } = await resolveContactConversation(
    channel as { id: string; workspace_id: string; platform: "youtube" } & YtChannel,
    c.authorChannelId,
    c.authorName,
    truncateCodePoints(c.text, 255),
    { mutateActivity: false, thread: { type: "comment", ref: c.videoId ?? "" } },
  );

  const loggedId = await db.transaction(async (tx) => {
    const [logged] = await tx
      .insert(commentLogs)
      .values({
        channel_id: channel.id,
        workspace_id: channel.workspace_id,
        post_id: c.videoId ?? null,
        platform_comment_id: c.commentId,
        author_id: c.authorChannelId,
        author_name: c.authorName,
        comment_text: c.text,
        conversation_id: conversationId,
      })
      .onConflictDoNothing({ target: [commentLogs.channel_id, commentLogs.platform_comment_id] })
      .returning({ id: commentLogs.id });
    if (!logged) return null;
    await tx.update(conversations).set({ last_message_at: new Date(), status: "open" }).where(eq(conversations.id, conversationId));
    await tx.update(contacts).set({ last_interaction_at: new Date() }).where(eq(contacts.id, contactId));
    await tx.update(conversations).set({ unread_count: sql`${conversations.unread_count} + 1` }).where(eq(conversations.id, conversationId));
    return logged.id;
  });
  if (!loggedId) return false; // already seen (cursor over-fetch or redelivery) — unique constraint dedups

  if (!isAutomationPaused && channel.status !== "paused") {
    const eventKey = `yt-comment:${channel.id}:${c.commentId}`;
    const { outcome } = await evaluateRules({
      workspaceId: channel.workspace_id,
      channelId: channel.id,
      platform: "youtube",
      conversationId,
      contactId,
      recipientPlatformId: c.authorChannelId,
      text: c.text,
      eventType: "comment",
      postId: c.videoId ?? undefined,
      commentId: c.commentId,
      eventKey,
    });
    if (outcome === "no_match") {
      await db.update(conversations).set({ needs_manual_reply: true }).where(eq(conversations.id, conversationId));
    }
  }
  return true;
}

export interface YouTubePollResult {
  ingested: number;
  quotaSpent: number;
  notModified: boolean;
}

/**
 * Poll one YouTube channel for new comments and ingest them into the inbox (per-video comment
 * threads) + run rules. Idle channels cost zero quota (ETag 304). Self-comments are skipped. The
 * cursor (ETag + newest publishedAt) is persisted on the channel so the next poll resumes exactly.
 */
export async function pollYouTubeChannel(
  channelId: string,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<YouTubePollResult> {
  const channel = await db.query.channels.findFirst({
    where: eq(channels.id, channelId),
    columns: { id: true, workspace_id: true, platform: true, status: true, platform_id: true, token_encrypted: true, last_comment_cursor: true },
  });
  if (!channel || channel.platform !== "youtube" || channel.status === "disabled") {
    return { ingested: 0, quotaSpent: 0, notModified: false };
  }

  let accessToken: string;
  try {
    accessToken = await freshYouTubeAccessToken(channel);
  } catch (err) {
    if (err instanceof YouTubeApiError && (err.status === 401 || err.status === 400)) {
      await markChannelNeedsReauth(channel.id, err.message).catch(() => {});
      return { ingested: 0, quotaSpent: 0, notModified: false };
    }
    throw err;
  }

  const cursor = parseCursor(channel.last_comment_cursor);
  let result;
  try {
    result = await pollCommentThreads({
      channelId: channel.platform_id,
      accessToken,
      etag: cursor.etag,
      sincePublishedAt: cursor.sincePublishedAt,
      fetchImpl: opts.fetchImpl,
    });
  } catch (err) {
    if (err instanceof YouTubeApiError && err.status === 401) {
      await markChannelNeedsReauth(channel.id, err.message).catch(() => {});
      return { ingested: 0, quotaSpent: 0, notModified: false };
    }
    console.error(`[youtube-poll] channel ${channel.id}: ${sanitizeForLog(err instanceof Error ? err.message : String(err))}`);
    throw err;
  }

  if (result.notModified) return { ingested: 0, quotaSpent: 0, notModified: true };

  // Process oldest-first so the cursor advances monotonically and the thread reads chronologically.
  let ingested = 0;
  let newest = cursor.sincePublishedAt;
  for (const c of [...result.comments].reverse()) {
    if (c.authorChannelId && c.authorChannelId === channel.platform_id) continue; // skip own comments
    newest = laterIso(newest, c.publishedAt);
    if (await ingestComment(channel, c)) ingested++;
  }

  await db
    .update(channels)
    .set({ last_comment_cursor: JSON.stringify({ etag: result.etag ?? null, sincePublishedAt: newest }) })
    .where(eq(channels.id, channel.id));

  return { ingested, quotaSpent: result.quotaSpent, notModified: false };
}

/** Poll every active YouTube channel (the scheduled sweep). Each channel is isolated. */
export async function sweepYouTubeChannels(): Promise<{ channels: number; ingested: number; quotaSpent: number }> {
  const rows = await db.query.channels.findMany({
    where: and(eq(channels.platform, "youtube"), eq(channels.status, "active")),
    columns: { id: true },
  });
  let ingested = 0;
  let quotaSpent = 0;
  for (const { id } of rows) {
    try {
      const r = await pollYouTubeChannel(id);
      ingested += r.ingested;
      quotaSpent += r.quotaSpent;
    } catch (err) {
      console.error(`[youtube-poll-sweep] channel ${id}: ${sanitizeForLog(err instanceof Error ? err.message : String(err))}`);
    }
  }
  return { channels: rows.length, ingested, quotaSpent };
}

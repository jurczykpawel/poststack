import { env } from "@/lib/env";
import { verifyMetaSignature } from "@/lib/crypto";
import { rateLimit } from "@/lib/api/rate-limit";
import { addJob } from "@/lib/queue/client";
import type { IncomingMessageJob, IncomingCommentJob, IncomingReactionJob } from "@/lib/queue/types";

export const runtime = "nodejs";

const VALID_PLATFORMS = new Set(["facebook", "instagram", "page"]);

// ─── Hub Verification (GET) ────────────────────────────────────────────────
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (mode === "subscribe" && env.META_WEBHOOK_VERIFY_TOKEN && token === env.META_WEBHOOK_VERIFY_TOKEN) {
    return new Response(challenge, { status: 200 });
  }

  return new Response("Forbidden", { status: 403 });
}

// ─── Webhook Events (POST) ────────────────────────────────────────────────
export async function POST(request: Request) {
  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256") ?? "";

  if (!env.META_APP_SECRET) {
    return new Response("Meta webhook not configured", { status: 503 });
  }

  if (!verifyMetaSignature(rawBody, signature, env.META_APP_SECRET)) {
    return new Response("Forbidden", { status: 403 });
  }

  // Rate limit webhook ingress (1000 events/minute -- well above Meta's normal rate)
  const rl = await rateLimit("rl:webhook:meta", 1000, 60);
  if (!rl.allowed) {
    return new Response("Too Many Requests", { status: 429 });
  }

  let payload: MetaWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as MetaWebhookPayload;
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  // Validate platform - Meta sends "page" for FB page webhooks, "instagram" for IG
  if (!VALID_PLATFORMS.has(payload.object)) {
    return Response.json({ status: "ignored", reason: "unsupported object type" });
  }

  // Normalize: Meta sends "page" for Facebook pages
  const platform = payload.object === "page" ? "facebook" : payload.object;

  let failed = 0;

  for (const entry of payload.entry ?? []) {
    // Messaging events (DMs)
    for (const messagingEvent of entry.messaging ?? []) {
      if (!messagingEvent.message?.mid) continue;

      // Skip echo messages (our own outbound messages echoed back by Meta)
      if (messagingEvent.message.is_echo) continue;

      const replyToStory = messagingEvent.message.reply_to?.story;
      const isStoryMention = messagingEvent.message.attachments?.some(
        (a) => (a as { type?: string }).type === "story_mention",
      );

      const job: IncomingMessageJob = {
        platform,
        pageId: entry.id,
        senderId: messagingEvent.sender.id,
        recipientId: messagingEvent.recipient.id,
        mid: messagingEvent.message.mid,
        text: messagingEvent.message.text ?? null,
        quickReplyPayload: messagingEvent.message.quick_reply?.payload,
        isStoryReply: replyToStory ? true : undefined,
        isStoryMention: isStoryMention ? true : undefined,
        storyId: replyToStory?.id,
        timestamp: Math.floor(messagingEvent.timestamp / 1000), // Meta sends ms; the worker expects seconds
        raw: messagingEvent as unknown as Record<string, unknown>,
      };

      try {
        await addJob("incoming-message", job, {
          jobKey: `msg-${messagingEvent.message.mid}`,
        });
      } catch (err) {
        failed++;
        console.error("[webhook] Failed to enqueue message:", err);
      }
    }

    // Postback events (button taps -- no message.mid, separate event type)
    for (const messagingEvent of entry.messaging ?? []) {
      if (!messagingEvent.postback?.payload) continue;
      if (messagingEvent.message) continue; // already handled above

      const job: IncomingMessageJob = {
        platform,
        pageId: entry.id,
        senderId: messagingEvent.sender.id,
        recipientId: messagingEvent.recipient.id,
        mid: `postback-${messagingEvent.sender.id}-${messagingEvent.timestamp}-${messagingEvent.postback!.payload}`,
        text: null,
        postbackPayload: messagingEvent.postback.payload,
        timestamp: Math.floor(messagingEvent.timestamp / 1000), // Meta sends ms; the worker expects seconds
        raw: messagingEvent as unknown as Record<string, unknown>,
      };

      try {
        await addJob("incoming-message", job, {
          jobKey: `postback-${messagingEvent.sender.id}-${messagingEvent.timestamp}-${messagingEvent.postback!.payload}`,
        });
      } catch (err) {
        failed++;
        console.error("[webhook] Failed to enqueue postback:", err);
      }
    }

    // Reaction events (emoji reaction to one of our messages -- separate event)
    for (const messagingEvent of entry.messaging ?? []) {
      const reaction = messagingEvent.reaction;
      if (!reaction || reaction.action !== "react") continue;

      const job: IncomingReactionJob = {
        platform,
        pageId: entry.id,
        senderId: messagingEvent.sender.id,
        reactedMid: reaction.mid,
        reactionType: reaction.reaction,
        emoji: reaction.emoji,
        timestamp: messagingEvent.timestamp,
        raw: messagingEvent as unknown as Record<string, unknown>,
      };

      try {
        await addJob("incoming-reaction", job, {
          jobKey: `reaction-${messagingEvent.sender.id}-${reaction.mid}-${messagingEvent.timestamp}`,
        });
      } catch (err) {
        failed++;
        console.error("[webhook] Failed to enqueue reaction:", err);
      }
    }

    // Comment events — Facebook (field "feed") and Instagram (field "comments")
    for (const change of entry.changes ?? []) {
      const comment = normalizeComment(change);
      if (!comment) continue;

      const job: IncomingCommentJob = {
        platform,
        pageId: entry.id,
        commentId: comment.commentId,
        postId: comment.postId,
        senderId: comment.senderId,
        senderName: comment.senderName,
        text: comment.text,
        timestamp: comment.timestamp,
        raw: change.value as Record<string, unknown>,
      };

      try {
        await addJob("incoming-comment", job, { jobKey: `comment-${comment.commentId}` });
      } catch (err) {
        failed++;
        console.error("[webhook] Failed to enqueue comment:", err);
      }
    }
  }

  // If ANY event failed to enqueue, signal a retry — Meta re-delivers the whole
  // batch and the jobs are keyed + idempotent, so re-running the ones that already
  // succeeded is harmless, whereas dropping the failed ones loses events.
  if (failed > 0) {
    return new Response("Service Unavailable", { status: 503 });
  }

  return Response.json({ status: "ok" });
}

// ─── Comment normalization ─────────────────────────────────────────────────

interface NormalizedComment {
  commentId: string;
  postId: string | undefined;
  senderId: string | undefined;
  senderName: string | undefined;
  text: string | undefined;
  timestamp: number | undefined;
}

/**
 * Normalize a comment change across platforms.
 * Facebook page comments arrive as field "feed" (item=comment, verb=add);
 * Instagram comments arrive as field "comments" with a flatter shape.
 */
function normalizeComment(change: ChangeEvent): NormalizedComment | null {
  const v = change.value;
  if (!v) return null;

  if (change.field === "feed") {
    if (v.item !== "comment" || v.verb !== "add" || !v.comment_id) return null;
    return {
      commentId: v.comment_id,
      postId: v.post_id ?? v.media_id,
      senderId: v.from?.id,
      senderName: v.from?.name,
      text: v.message,
      timestamp: v.created_time,
    };
  }

  if (change.field === "comments") {
    if (!v.id) return null;
    return {
      commentId: v.id,
      postId: v.media?.id ?? v.media_id,
      senderId: v.from?.id,
      senderName: v.from?.username ?? v.from?.name,
      text: v.text,
      timestamp: v.created_time,
    };
  }

  return null;
}

// ─── Types ────────────────────────────────────────────────────────────────

interface MetaWebhookPayload {
  object: string;
  entry: Array<{
    id: string;
    messaging?: MessagingEvent[];
    changes?: ChangeEvent[];
  }>;
}

interface MessagingEvent {
  sender: { id: string };
  recipient: { id: string };
  timestamp: number;
  message?: {
    mid: string;
    text?: string;
    is_echo?: boolean;
    quick_reply?: { payload: string };
    attachments?: unknown[];
    reply_to?: { story?: { id?: string; url?: string } };
  };
  postback?: {
    payload: string;
    title?: string;
  };
  reaction?: {
    mid: string;
    action: string;
    emoji?: string;
    reaction?: string;
  };
}

interface ChangeEvent {
  field: string;
  value: {
    // Facebook "feed" comment fields
    item?: string;
    verb?: string;
    comment_id?: string;
    post_id?: string;
    message?: string;
    // Instagram "comments" fields
    id?: string;
    text?: string;
    media?: { id?: string };
    media_id?: string;
    from?: { id: string; name?: string; username?: string };
    created_time?: number;
    [key: string]: unknown;
  };
}

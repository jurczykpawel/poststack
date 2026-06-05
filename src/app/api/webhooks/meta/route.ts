import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { verifyMetaSignature } from "@/lib/crypto";
import { rateLimit } from "@/lib/api/rate-limit";
import { addJob } from "@/lib/queue/client";
import type { IncomingMessageJob, IncomingCommentJob } from "@/lib/queue/types";

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
    return NextResponse.json({ status: "ignored", reason: "unsupported object type" });
  }

  // Normalize: Meta sends "page" for Facebook pages
  const platform = payload.object === "page" ? "facebook" : payload.object;

  let enqueued = 0;
  let failed = 0;

  for (const entry of payload.entry ?? []) {
    // Messaging events (DMs)
    for (const messagingEvent of entry.messaging ?? []) {
      if (!messagingEvent.message?.mid) continue;

      // Skip echo messages (our own outbound messages echoed back by Meta)
      if (messagingEvent.message.is_echo) continue;

      const job: IncomingMessageJob = {
        platform,
        pageId: entry.id,
        senderId: messagingEvent.sender.id,
        recipientId: messagingEvent.recipient.id,
        mid: messagingEvent.message.mid,
        text: messagingEvent.message.text ?? null,
        quickReplyPayload: messagingEvent.message.quick_reply?.payload,
        timestamp: messagingEvent.timestamp,
        raw: messagingEvent as unknown as Record<string, unknown>,
      };

      try {
        await addJob("incoming-message", job, {
          jobKey: `msg-${messagingEvent.message.mid}`,
        });
        enqueued++;
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
        timestamp: messagingEvent.timestamp,
        raw: messagingEvent as unknown as Record<string, unknown>,
      };

      try {
        await addJob("incoming-message", job, {
          jobKey: `postback-${messagingEvent.sender.id}-${messagingEvent.timestamp}-${messagingEvent.postback!.payload}`,
        });
        enqueued++;
      } catch (err) {
        failed++;
        console.error("[webhook] Failed to enqueue postback:", err);
      }
    }

    // Comment events
    for (const change of entry.changes ?? []) {
      if (
        change.field === "feed" &&
        change.value?.item === "comment" &&
        change.value.verb === "add" &&
        change.value.comment_id
      ) {
        const job: IncomingCommentJob = {
          platform,
          pageId: entry.id,
          commentId: change.value.comment_id,
          postId: change.value.post_id ?? change.value.media_id,
          senderId: change.value.from?.id,
          senderName: change.value.from?.name,
          text: change.value.message,
          timestamp: change.value.created_time,
          raw: change.value as Record<string, unknown>,
        };

        try {
          await addJob("incoming-comment", job, {
            jobKey: `comment-${change.value.comment_id}`,
          });
          enqueued++;
        } catch (err) {
          failed++;
          console.error("[webhook] Failed to enqueue comment:", err);
        }
      }
    }
  }

  // Return 503 if all enqueues failed (Meta will retry)
  if (failed > 0 && enqueued === 0) {
    return new Response("Service Unavailable", { status: 503 });
  }

  return NextResponse.json({ status: "ok" });
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
  };
  postback?: {
    payload: string;
    title?: string;
  };
}

interface ChangeEvent {
  field: string;
  value: {
    item?: string;
    verb?: string;
    comment_id?: string;
    post_id?: string;
    media_id?: string;
    from?: { id: string; name: string };
    message?: string;
    created_time?: number;
    [key: string]: unknown;
  };
}

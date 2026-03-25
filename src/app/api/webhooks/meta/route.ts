import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { verifyMetaSignature } from "@/lib/crypto";
import { incomingMessagesQueue, incomingCommentsQueue } from "@/lib/queue/client";
import type { IncomingMessageJob, IncomingCommentJob } from "@/lib/queue/types";

export const runtime = "nodejs";

// ─── Hub Verification (GET) ────────────────────────────────────────────────
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === env.META_WEBHOOK_VERIFY_TOKEN) {
    return new Response(challenge, { status: 200 });
  }

  return new Response("Forbidden", { status: 403 });
}

// ─── Webhook Events (POST) ────────────────────────────────────────────────
export async function POST(request: Request) {
  // 1. Read raw body for HMAC verification
  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256") ?? "";

  if (!verifyMetaSignature(rawBody, signature, env.META_APP_SECRET)) {
    return new Response("Forbidden", { status: 403 });
  }

  let payload: MetaWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as MetaWebhookPayload;
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  // 2. Route to appropriate queues
  for (const entry of payload.entry ?? []) {
    // Messaging events (DMs)
    for (const messagingEvent of entry.messaging ?? []) {
      if (messagingEvent.message) {
        const job: IncomingMessageJob = {
          platform: payload.object as "facebook" | "instagram",
          pageId: entry.id,
          senderId: messagingEvent.sender.id,
          recipientId: messagingEvent.recipient.id,
          mid: messagingEvent.message.mid,
          text: messagingEvent.message.text ?? null,
          timestamp: messagingEvent.timestamp,
          raw: messagingEvent as unknown as Record<string, unknown>,
        };
        await incomingMessagesQueue.add("incoming-message", job, {
          jobId: `msg-${messagingEvent.message.mid}`,
        });
      }
    }

    // Comment events
    for (const change of entry.changes ?? []) {
      if (
        change.field === "feed" &&
        change.value?.item === "comment" &&
        change.value.verb === "add"
      ) {
        const job: IncomingCommentJob = {
          platform: payload.object as "facebook" | "instagram",
          pageId: entry.id,
          commentId: change.value.comment_id ?? "",
          postId: change.value.post_id ?? change.value.media_id,
          senderId: change.value.from?.id,
          senderName: change.value.from?.name,
          text: change.value.message,
          timestamp: change.value.created_time,
          raw: change.value,
        };
        await incomingCommentsQueue.add("incoming-comment", job, {
          jobId: `comment-${change.value.comment_id}`,
        });
      }
    }
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
    attachments?: unknown[];
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

import { createHash, timingSafeEqual } from "crypto";
import { and, eq, ne } from "drizzle-orm";
import { getConfig } from "@/lib/settings/config";
import { db } from "@/lib/db";
import { channels, type Platform } from "@/db/schema";
import { verifyMetaSignatureAny } from "@/lib/crypto";
import { rateLimit } from "@/lib/api/rate-limit";
import { addJob } from "@/lib/queue/client";
import { logEvent, markEventStatus } from "@/lib/idempotency";
import { classifyMessagingEvent, classifyChangeEvent } from "@/lib/webhook-events/log";
import type { IncomingMessageJob, IncomingCommentJob, IncomingReactionJob, IncomingPostReactionJob, IncomingEchoJob, IncomingReceiptJob } from "@/lib/queue/types";
import { sanitizeForLog } from "@/lib/api/safe-log";

export const runtime = "nodejs";

const VALID_PLATFORMS = new Set(["facebook", "instagram", "page"]);

/** Constant-time string compare via fixed-length SHA-256 digests (matches the CRON/HMAC checks),
 *  so the verify-token compare doesn't leak length/prefix through timing. */
async function verifyTokenMatches(provided: string | null): Promise<boolean> {
  const expected = await getConfig("META_WEBHOOK_VERIFY_TOKEN");
  if (!expected || provided == null) return false;
  const digest = (v: string) => createHash("sha256").update(v).digest();
  return timingSafeEqual(digest(provided), digest(expected));
}

// ─── Hub Verification (GET) ────────────────────────────────────────────────
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (mode === "subscribe" && (await verifyTokenMatches(token))) {
    return new Response(challenge, { status: 200 });
  }

  return new Response("Forbidden", { status: 403 });
}

/** Hard cap on the webhook body before we buffer it. Meta events are tiny; this just stops
 *  an unauthenticated client forcing a huge body into memory ahead of the HMAC check.
 *  The reverse proxy (Caddy/nginx) should also set a request-body limit as defence-in-depth. */
const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024; // 1 MiB

// ─── Webhook Events (POST) ────────────────────────────────────────────────
export async function POST(request: Request) {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_WEBHOOK_BODY_BYTES) {
    return new Response("Payload Too Large", { status: 413 });
  }

  const rawBody = await request.text();
  // Enforce the cap on the ACTUAL bytes too, not just the declared Content-Length: a chunked /
  // header-less request bypasses the check above, so re-check after reading and reject before
  // the HMAC/parse. nginx's client_max_body_size is the prod-level guard.
  if (Buffer.byteLength(rawBody) > MAX_WEBHOOK_BODY_BYTES) {
    return new Response("Payload Too Large", { status: 413 });
  }
  const signature = request.headers.get("x-hub-signature-256") ?? "";

  const appSecret = await getConfig("META_APP_SECRET");
  const igAppSecret = await getConfig("INSTAGRAM_APP_SECRET");
  if (!appSecret) {
    return new Response("Meta webhook not configured", { status: 503 });
  }
  if (!verifyMetaSignatureAny(rawBody, signature, [appSecret, igAppSecret])) {
    return new Response("Forbidden", { status: 403 });
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

  // Rate limit webhook ingress PER PAGE (1000 events/minute — well above Meta's normal rate). A
  // single instance-wide counter let one viral page's burst exhaust the shared budget and starve
  // every other page's events; a per-page key isolates them. Done after HMAC verification, so only
  // Meta-signed traffic can mint these keys. A payload with no usable page id falls back to
  // one instance-wide bucket so every signed request stays bounded (no rate-limit bypass).
  // (A multi-page batch redelivered after one page tripped its limit re-counts the under-limit pages;
  // accepted given the generous ceiling, the hourly counter prune, and idempotent job keys.)
  const pageIds = [...new Set((payload.entry ?? []).map((e) => e.id).filter((id): id is string => typeof id === "string"))];
  const rlKeys = pageIds.length > 0 ? pageIds.map((id) => `rl:webhook:meta:${id}`) : ["rl:webhook:meta"];
  for (const key of rlKeys) {
    const rl = await rateLimit(key, 1000, 60);
    if (!rl.allowed) {
      return new Response("Too Many Requests", { status: 429 });
    }
  }

  // Normalize: Meta sends "page" for Facebook pages
  const platform: Platform = (payload.object === "page" ? "facebook" : payload.object) as Platform;

  // Resolve each page id to its channel once (best-effort), so every logged event can carry
  // channel_id. A page unknown to us logs with channel_id=null — still recorded, never dropped.
  const channelByPage = await resolveChannels(pageIds, platform);

  let failed = 0;

  for (const entry of payload.entry ?? []) {
    const channelId = channelByPage.get(entry.id) ?? null;

    // Every messaging event → one log row (handled, unhandled, echo) — never dropped. Echo +
    // delivery/read receipts now enqueue jobs (THREADSYNC1: confirm/record into the thread), so the
    // edge no longer needs a post-log step.
    for (const evt of entry.messaging ?? []) {
      const classified = classifyMessagingEvent(evt as Parameters<typeof classifyMessagingEvent>[0], platform, entry.id, payload.object);
      if (!classified) continue;
      const enqueueMessaging = () => enqueueFromClassified(classified, evt as MessagingEvent, entry.id, platform);
      failed += await processClassified(classified, channelId, enqueueMessaging);
    }

    // Every change event (comments + everything else) → one log row.
    for (const change of entry.changes ?? []) {
      const classified = classifyChangeEvent(change as Parameters<typeof classifyChangeEvent>[0], platform, payload.object);
      if (!classified) continue;
      const enqueueChange = () =>
        classified.job?.task === "incoming-post-reaction"
          ? enqueuePostReaction(classified, change, entry.id, platform)
          : enqueueComment(classified, change, entry.id, platform);
      failed += await processClassified(classified, channelId, enqueueChange);
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

/** Resolve the active channel id for each receiving page id, scoped by platform (globally
 *  unique non-disabled owner). Best-effort: an unresolved page yields no entry (channel_id=null). */
async function resolveChannels(pageIds: string[], platform: Platform): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (pageIds.length === 0) return map;
  try {
    const rows = await db.query.channels.findMany({
      where: and(eq(channels.platform, platform), ne(channels.status, "disabled")),
      columns: { id: true, platform_id: true },
    });
    const want = new Set(pageIds);
    for (const r of rows) if (want.has(r.platform_id)) map.set(r.platform_id, r.id);
  } catch (err) {
    console.error("[webhook] channel resolution failed:", err);
  }
  return map;
}

/**
 * Log one classified event durably, then act on it. Wrapped so a per-event failure (a logging
 * error or an enqueue error) is contained: a logging failure is swallowed (return 0 → still 200,
 * Meta won't retry a row we couldn't persist anyway), while an enqueue failure on a handled event
 * signals a retry (return 1 → 503).
 *
 * The enqueue is NOT gated on whether THIS delivery created the log row. Gating on `created` would
 * strand an event forever if the first delivery logged the row but its enqueue then failed (the
 * 503-driven redelivery would skip the enqueue). A redelivered enqueue is a safe no-op: graphile
 * dedups a still-pending jobKey, and the worker's received→terminal CAS fires at most once. Every
 * downstream step (markEventStatus, the echo afterLog) is likewise idempotent.
 */
async function processClassified(
  classified: { log: Parameters<typeof logEvent>[0]; job: { task: string; jobKey: string } | null; terminalStatus?: "unhandled" | "ignored" },
  channelId: string | null,
  enqueue: () => Promise<void>,
  afterLog?: () => Promise<void>,
): Promise<number> {
  try {
    await logEvent({ ...classified.log, channel_id: channelId });
  } catch (err) {
    // A logging failure must not return early — fall through to the enqueue. logEvent and addJob
    // share the same DB: if logging failed from a transient outage the enqueue fails too → 503 →
    // Meta retries (the rescue); otherwise the job is still created. (Telegram route does the same.)
    console.error(`[webhook] failed to log event ${sanitizeForLog(classified.log.event_key)}:`, err);
  }

  // No-job event (unhandled type, malformed, or echo): mark terminal where applicable, run any
  // post-log step. All idempotent (only a `received` row transitions), so a redelivery is a no-op.
  if (!classified.job) {
    if (classified.terminalStatus) {
      await markEventStatus(classified.log.event_key, classified.terminalStatus).catch(() => {});
    }
    if (afterLog) await afterLog().catch((err) => console.error("[webhook] post-log step failed:", err));
    return 0;
  }

  // Handled type: always enqueue (idempotent). A failed enqueue → 503 (Meta retries the whole batch).
  try {
    await enqueue();
  } catch (err) {
    console.error(`[webhook] failed to enqueue ${classified.job.task}:`, err);
    return 1;
  }
  return 0;
}

/** Build + enqueue the incoming-message / incoming-reaction job for a classified messaging event. */
async function enqueueFromClassified(
  classified: { log: { event_key: string; event_type: string }; job: { jobKey: string } | null },
  evt: MessagingEvent,
  pageId: string,
  platform: Platform,
): Promise<void> {
  const eventKey = classified.log.event_key;
  if (classified.log.event_type === "reaction") {
    const reaction = evt.reaction!;
    const job: IncomingReactionJob = {
      platform, pageId, eventKey,
      senderId: evt.sender!.id,
      reactedMid: reaction.mid,
      reactionType: reaction.reaction,
      emoji: reaction.emoji,
      // Normalize ms→seconds like the DM/postback events; any future Date() use is otherwise ~3y off.
      timestamp: Math.floor(evt.timestamp / 1000),
    };
    await addJob("incoming-reaction", job, { jobKey: eventKey });
    return;
  }

  // THREADSYNC1: echo of a page-sent message → record it into the thread (and confirm our own sends).
  if (classified.log.event_type === "echo") {
    const job: IncomingEchoJob = {
      platform, pageId, eventKey,
      recipientId: evt.recipient!.id,
      mid: evt.message!.mid,
      text: evt.message?.text ?? null,
      timestamp: Math.floor(evt.timestamp / 1000),
    };
    await addJob("incoming-echo", job, { jobKey: eventKey });
    return;
  }

  // THREADSYNC1: read / delivery receipt → mark our outbound messages seen / delivered.
  if (classified.log.event_type === "seen" || classified.log.event_type === "delivery") {
    const job: IncomingReceiptJob = {
      platform, pageId, eventKey,
      userId: evt.sender!.id,
      kind: classified.log.event_type === "seen" ? "read" : "delivered",
      watermark: evt.read?.watermark ?? evt.delivery?.watermark ?? 0,
      mids: evt.delivery?.mids,
    };
    await addJob("incoming-receipt", job, { jobKey: eventKey });
    return;
  }

  // message / story_reply / story_mention / postback → incoming-message
  const replyToStory = evt.message?.reply_to?.story;
  const isStoryMention = evt.message?.attachments?.some((a) => (a as { type?: string }).type === "story_mention");
  const job: IncomingMessageJob = {
    platform, pageId, eventKey,
    senderId: evt.sender!.id,
    recipientId: evt.recipient!.id,
    mid: evt.message?.mid ?? eventKey,
    text: evt.message?.text ?? null,
    quickReplyPayload: evt.message?.quick_reply?.payload,
    postbackPayload: evt.postback?.payload,
    isStoryReply: replyToStory ? true : undefined,
    isStoryMention: isStoryMention ? true : undefined,
    storyId: replyToStory?.id,
    timestamp: Math.floor(evt.timestamp / 1000), // Meta sends ms; the worker expects seconds
  };
  await addJob("incoming-message", job, { jobKey: classified.job!.jobKey });
}

/** Build + enqueue the incoming-comment job for a classified change event. */
async function enqueueComment(
  classified: { log: { event_key: string }; job: { jobKey: string } | null },
  change: ChangeEvent,
  pageId: string,
  platform: Platform,
): Promise<void> {
  const comment = normalizeComment(change);
  if (!comment) return; // classifier said handled, so this is non-null in practice
  const job: IncomingCommentJob = {
    platform, pageId,
    eventKey: classified.log.event_key,
    commentId: comment.commentId,
    postId: comment.postId,
    senderId: comment.senderId,
    senderName: comment.senderName,
    text: comment.text,
    timestamp: comment.timestamp,
  };
  await addJob("incoming-comment", job, { jobKey: classified.job!.jobKey });
}

/** Build + enqueue the incoming-post-reaction job for a classified Facebook feed reaction/like. */
async function enqueuePostReaction(
  classified: { log: { event_key: string }; job: { jobKey: string } | null },
  change: ChangeEvent,
  pageId: string,
  platform: Platform,
): Promise<void> {
  const v = (change.value ?? {}) as Record<string, unknown> & {
    item?: string; verb?: string; post_id?: string; reaction_type?: string;
    from?: { id?: string; name?: string }; created_time?: number;
  };
  const job: IncomingPostReactionJob = {
    platform, pageId,
    eventKey: classified.log.event_key,
    postId: v.post_id as string,
    reactorId: v.from?.id as string,
    reactorName: v.from?.name,
    reactionType: v.item === "like" ? "like" : (v.reaction_type ?? "unknown"),
    verb: v.verb === "remove" ? "remove" : "add",
    timestamp: v.created_time,
  };
  await addJob("incoming-post-reaction", job, { jobKey: classified.job!.jobKey });
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
  read?: { watermark?: number };
  delivery?: { mids?: string[]; watermark?: number };
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

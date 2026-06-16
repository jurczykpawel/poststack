import { createHash } from "crypto";
import type { LogEventInput } from "@/lib/idempotency";
import type { Platform } from "@/db/schema";

/**
 * Classification of a single inbound Meta event into the durable webhook_events row + the handler
 * job (if any) the edge should enqueue. `job` is null for events we log but do not act on
 * (unhandled types, echoes, intentionally-ignored shapes); its presence tells the edge a handled
 * job exists and which task + key to enqueue with.
 */
export interface ClassifiedEvent {
  log: LogEventInput;
  /** Set for handled types → enqueue this task with this jobKey; null → log only (no job). */
  job: {
    task: "incoming-message" | "incoming-comment" | "incoming-reaction" | "incoming-post-reaction" | "incoming-echo" | "incoming-receipt";
    jobKey: string;
  } | null;
  /** When the logged row should land terminal immediately instead of `received`: `unhandled` for a
   *  recognized type with no handler, `ignored` for a malformed event that can't be processed. */
  terminalStatus?: "unhandled" | "ignored";
}

/** Hash an operator-controlled string into a fixed-length token for an event key (keeps the
 *  key within graphile's 512-char jobKey cap when the source can be up to 1000 chars). */
function hash16(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

// ─── Meta payload shapes (mirror webhooks/meta/route.ts) ────────────────────

export interface MetaMessagingEvent {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp: number;
  message?: {
    mid: string;
    text?: string;
    is_echo?: boolean;
    quick_reply?: { payload: string };
    attachments?: unknown[];
    reply_to?: { story?: { id?: string; url?: string } };
  };
  postback?: { payload: string; title?: string };
  reaction?: { mid: string; action: string; emoji?: string; reaction?: string };
  optin?: unknown;
  read?: { watermark?: number };
  delivery?: { mids?: string[]; watermark?: number };
}

export interface MetaChangeEvent {
  field: string;
  value?: Record<string, unknown> & {
    item?: string;
    verb?: string;
    comment_id?: string;
    from?: { id?: string; name?: string; username?: string };
    id?: string;
    post_id?: string;
    reaction_type?: string;
  };
}

/**
 * Classify a `messaging` array event (DM / postback / reaction / echo / story_* / optin / seen /
 * delivery / unknown). `platform` is the resolved platform; `pageId` the receiving account. Every
 * event yields a log row; only handled, well-formed types yield a job.
 */
export function classifyMessagingEvent(
  evt: MetaMessagingEvent,
  platform: Platform,
  pageId: string,
  object: string,
): ClassifiedEvent | null {
  const senderId = evt.sender?.id ?? null;
  const recipientId = evt.recipient?.id ?? null;
  const base = { platform, object, sender_id: senderId, recipient_id: recipientId, raw: evt as unknown };

  // Echo of a message the PAGE sent, echoed back by Meta. THREADSYNC1: enqueued so the worker confirms
  // our own delivery AND records a message sent from elsewhere (FB app / Business Suite / n8n) into the
  // thread, keeping the conversation whole. The worker dedups our own already-recorded sends.
  if (evt.message?.is_echo) {
    return {
      log: { ...base, event_key: `echo-${evt.message.mid}`, event_type: "echo", platform_message_id: evt.message.mid, is_echo: true },
      job: { task: "incoming-echo", jobKey: `echo-${evt.message.mid}` },
    };
  }

  // A normal DM (has a message.mid). story_reply / story_mention are still `message` events here;
  // the worker reads the story flags off the job payload, so the event_type stays `message`.
  if (evt.message?.mid) {
    const isStoryMention = evt.message.attachments?.some((a) => (a as { type?: string }).type === "story_mention");
    const eventType = evt.message.reply_to?.story ? "story_reply" : isStoryMention ? "story_mention" : "message";
    // Well-formed only when sender + recipient are present (the worker dereferences them). A
    // malformed event is logged but can't be processed → land it terminal `ignored`, not stuck `received`.
    const wellFormed = !!(senderId && recipientId);
    return {
      log: { ...base, event_key: `msg-${evt.message.mid}`, event_type: eventType, platform_message_id: evt.message.mid },
      job: wellFormed ? { task: "incoming-message", jobKey: `msg-${evt.message.mid}` } : null,
      ...(wellFormed ? {} : { terminalStatus: "ignored" as const }),
    };
  }

  // Postback (button tap). The payload can be up to 1000 chars — hash it into the key.
  if (evt.postback?.payload) {
    const key = `postback-${senderId}-${evt.timestamp}-${hash16(evt.postback.payload)}`;
    const wellFormed = !!(senderId && recipientId);
    return {
      log: { ...base, event_key: key, event_type: "postback" },
      job: wellFormed ? { task: "incoming-message", jobKey: key } : null,
      ...(wellFormed ? {} : { terminalStatus: "ignored" as const }),
    };
  }

  // Reaction. action=react is handled; action=unreact (reaction_remove) is logged but not acted on.
  if (evt.reaction) {
    const r = evt.reaction;
    const key = `reaction-${senderId}-${r.mid}-${evt.timestamp}`;
    if (r.action === "react") {
      return {
        log: { ...base, event_key: key, event_type: "reaction", platform_message_id: r.mid },
        job: senderId ? { task: "incoming-reaction", jobKey: key } : null,
        ...(senderId ? {} : { terminalStatus: "ignored" as const }),
      };
    }
    return {
      log: { ...base, event_key: `reaction_remove-${senderId}-${r.mid}-${evt.timestamp}`, event_type: "reaction_remove", platform_message_id: r.mid },
      job: null,
      terminalStatus: "unhandled",
    };
  }

  // THREADSYNC1: read + delivery receipts mark our outbound messages seen / delivered in the thread.
  // A receipt is only actionable with a sender (whose conversation it scopes) and a watermark.
  if (evt.read) {
    const key = `seen-${senderId}-${evt.timestamp}`;
    const actionable = !!(senderId && typeof evt.read.watermark === "number");
    return {
      log: { ...base, event_key: key, event_type: "seen" },
      job: actionable ? { task: "incoming-receipt", jobKey: key } : null,
      ...(actionable ? {} : { terminalStatus: "unhandled" as const }),
    };
  }
  if (evt.delivery) {
    const key = `delivery-${senderId}-${evt.timestamp}`;
    const actionable = !!(senderId && (typeof evt.delivery.watermark === "number" || (evt.delivery.mids?.length ?? 0) > 0));
    return {
      log: { ...base, event_key: key, event_type: "delivery" },
      job: actionable ? { task: "incoming-receipt", jobKey: key } : null,
      ...(actionable ? {} : { terminalStatus: "unhandled" as const }),
    };
  }

  // Recognized-but-unhandled messaging shapes (optin). Logged for inspection; no handler.
  if (evt.optin) return unhandledMessaging(base, `optin-${senderId}-${evt.timestamp}`, "optin");

  // Anything else: a wholly-unknown messaging shape. Log it under a content hash so the row is
  // stable + unique, for later inspection. No job.
  return unhandledMessaging(base, `unknown-${hash16(JSON.stringify(evt))}`, "unknown");
}

function unhandledMessaging(
  base: { platform: Platform; object: string; sender_id: string | null; recipient_id: string | null; raw: unknown },
  eventKey: string,
  eventType: string,
): ClassifiedEvent {
  return { log: { ...base, event_key: eventKey, event_type: eventType }, job: null, terminalStatus: "unhandled" };
}

/**
 * Classify a `changes` array event (comment on a Facebook feed / Instagram comments, or any other
 * change field). A well-formed comment-add yields an incoming-comment job; everything else is
 * logged `unhandled`.
 */
export function classifyChangeEvent(
  change: MetaChangeEvent,
  platform: Platform,
  object: string,
): ClassifiedEvent | null {
  const v = change.value ?? {};
  const field = change.field;

  // Facebook page comment: field=feed, item=comment, verb=add.
  if (field === "feed" && v.item === "comment" && v.verb === "add" && v.comment_id) {
    const key = `cmt-${v.comment_id}-add`;
    return {
      log: {
        platform, object, field, raw: change as unknown,
        event_key: key, event_type: "comment", platform_message_id: v.comment_id,
        sender_id: v.from?.id ?? null,
      },
      job: { task: "incoming-comment", jobKey: `comment-${v.comment_id}` },
    };
  }

  // Facebook post reaction/like: field=feed, item=reaction|like, verb=add|edit|remove. A reactor id +
  // post id are required to record (and dedup) it; remove deletes the row, add/edit upsert the current
  // reaction_type (edit = the reactor swapped e.g. 👍→😆). Reactions on comments (which carry a
  // comment_id) are not post reactions.
  if (field === "feed" && (v.item === "reaction" || v.item === "like") && (v.verb === "add" || v.verb === "edit" || v.verb === "remove") && !v.comment_id) {
    const reactorId = v.from?.id;
    if (reactorId && v.post_id) {
      const key = `postreact-${v.post_id}-${reactorId}-${v.verb}`;
      return {
        log: {
          platform, object, field, raw: change as unknown,
          event_key: key, event_type: "post_reaction", sender_id: reactorId,
        },
        job: { task: "incoming-post-reaction", jobKey: `postreact-${v.post_id}-${reactorId}` },
      };
    }
  }

  // Instagram comment: field=comments with a flatter shape.
  if (field === "comments" && v.id) {
    const key = `cmt-${v.id}-add`;
    return {
      log: {
        platform, object, field, raw: change as unknown,
        event_key: key, event_type: "comment", platform_message_id: v.id,
        sender_id: v.from?.id ?? null,
      },
      job: { task: "incoming-comment", jobKey: `comment-${v.id}` },
    };
  }

  // Any other change (feed verb=edit/remove, comment_id-less feed item, mentions, other fields):
  // logged for inspection, no handler. Key on field + a content hash so it is stable + unique.
  const commentId = v.comment_id ?? v.id;
  const verb = v.verb;
  const keyId = commentId ?? hash16(JSON.stringify(change));
  const key = `change-${field}-${keyId}${verb ? `-${verb}` : ""}`;
  return {
    log: {
      platform, object, field, raw: change as unknown,
      event_key: key, event_type: "unknown",
      platform_message_id: typeof commentId === "string" ? commentId : null,
      sender_id: v.from?.id ?? null,
    },
    job: null,
    terminalStatus: "unhandled",
  };
}

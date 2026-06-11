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
  job: { task: "incoming-message" | "incoming-comment" | "incoming-reaction"; jobKey: string } | null;
  /** When the logged row should land terminal immediately (unhandled type) instead of `received`. */
  terminalStatus?: "unhandled";
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
  read?: unknown;
  delivery?: unknown;
}

export interface MetaChangeEvent {
  field: string;
  value?: Record<string, unknown> & {
    item?: string;
    verb?: string;
    comment_id?: string;
    from?: { id?: string; name?: string; username?: string };
    id?: string;
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

  // Echo of one of OUR sent messages, echoed back by Meta. Logged for delivery confirmation, never
  // enqueued as an inbound message.
  if (evt.message?.is_echo) {
    return {
      log: { ...base, event_key: `echo-${evt.message.mid}`, event_type: "echo", platform_message_id: evt.message.mid, is_echo: true },
      job: null,
    };
  }

  // A normal DM (has a message.mid). story_reply / story_mention are still `message` events here;
  // the worker reads the story flags off the job payload, so the event_type stays `message`.
  if (evt.message?.mid) {
    const isStoryMention = evt.message.attachments?.some((a) => (a as { type?: string }).type === "story_mention");
    const eventType = evt.message.reply_to?.story ? "story_reply" : isStoryMention ? "story_mention" : "message";
    return {
      log: { ...base, event_key: `msg-${evt.message.mid}`, event_type: eventType, platform_message_id: evt.message.mid },
      // Well-formed only when sender + recipient are present (the worker dereferences them).
      job: senderId && recipientId ? { task: "incoming-message", jobKey: `msg-${evt.message.mid}` } : null,
    };
  }

  // Postback (button tap). The payload can be up to 1000 chars — hash it into the key.
  if (evt.postback?.payload) {
    const key = `postback-${senderId}-${evt.timestamp}-${hash16(evt.postback.payload)}`;
    return {
      log: { ...base, event_key: key, event_type: "postback" },
      job: senderId && recipientId ? { task: "incoming-message", jobKey: key } : null,
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
      };
    }
    return {
      log: { ...base, event_key: `reaction_remove-${senderId}-${r.mid}-${evt.timestamp}`, event_type: "reaction_remove", platform_message_id: r.mid },
      job: null,
      terminalStatus: "unhandled",
    };
  }

  // Recognized-but-unhandled messaging shapes (optin / read receipt / delivery receipt). Logged so
  // support can inspect them; no handler exists, so no job. A synthetic key keeps the row unique.
  if (evt.optin) return unhandledMessaging(base, `optin-${senderId}-${evt.timestamp}`, "optin");
  if (evt.read) return unhandledMessaging(base, `seen-${senderId}-${evt.timestamp}`, "seen");
  if (evt.delivery) return unhandledMessaging(base, `delivery-${senderId}-${evt.timestamp}`, "delivery");

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

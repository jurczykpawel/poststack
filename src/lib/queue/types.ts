import type { MessageContent } from "@/lib/platforms/base";

/**
 * TIMING2: stamp carried by the FIRST outbound response to an inbound trigger, so the delivery
 * worker can fill `response_metrics.first_response_ms` when the send reaches `sent`. Optional on
 * every outbound payload — absence means "don't measure this send" (backward compatible). Only the
 * first measurable response per trigger ever sets the metric (first-write-wins in the delivery).
 */
export interface FirstResponseStamp {
  /** webhook_events.id of the inbound event that triggered this response. */
  triggerEventId?: string;
  /** The trigger event's received_at, as an ISO-8601 string — the clock the latency measures from. */
  triggerReceivedAt?: string;
  /** True only for the first response to the trigger (a direct reply, or a sequence's step-0 message). */
  measurable?: boolean;
}

export interface IncomingMessageJob {
  /** "facebook" | "instagram" | "telegram" */
  platform: string;
  /** Resolved channel id, when the webhook already identified it (Telegram). Preferred over pageId lookup. */
  channelId?: string;
  /** The FB Page ID / IG Account ID / Telegram bot ID that received the message */
  pageId: string;
  /** Platform-native sender PSID / IG user ID */
  senderId: string;
  recipientId: string;
  /** Platform message ID — used for deduplication */
  mid: string;
  /** webhook_events.event_key the edge logged this event under. The worker uses it for the
   *  received→terminal fire-claim CAS, so the claim lands on the same logged row. */
  eventKey?: string;
  text: string | null;
  quickReplyPayload?: string;
  postbackPayload?: string;
  /** Message is a reply to one of our stories */
  isStoryReply?: boolean;
  /** Message mentions us in the sender's story */
  isStoryMention?: boolean;
  /** Story being replied to (when isStoryReply) */
  storyId?: string;
  timestamp: number;
}

export interface OutgoingCommentJob extends FirstResponseStamp {
  channelId: string;
  /** The addressed contact — stamped on the delivery ledger so erasure cascades + the queue
   *  PII scrub reach the (personalized) public-reply text too. */
  contactId: string;
  commentId: string;
  text: string;
  sentByRuleId?: string;
  idempotencyKey?: string;
}

/** FIRSTCOMMENT1: auto-post the configured "first comment" UNDER a just-published post. Enqueued by
 *  the publish worker after `post.published`; runs through the durable delivery state machine so a
 *  crash can't double-post. Best-effort — failing it never affects the published post itself. */
export interface OutgoingFirstCommentJob {
  channelId: string;
  /** Platform-native id of the just-published post/media/video (the publish handle). */
  postId: string;
  text: string;
  idempotencyKey?: string;
}

/** STORY1: auto-publish a generated Story card about a just-published post. Enqueued by the publish
 *  worker after `post.published`; renders the card, uploads it to public storage, then publishes via
 *  the platform's `publishStory`. Runs through the durable delivery state machine so a crash can't
 *  double-post; best-effort — failing it never affects the published post itself. */
export interface PublishStoryJob {
  channelId: string;
  /** The publish (deliveries) row id — source of the post's media + caption, and the idempotency anchor. */
  deliveryId: string;
  idempotencyKey?: string;
}

/** THREADSYNC1: a message the PAGE sent that wasn't sent by us (FB app / Business Suite / n8n), echoed
 *  back by Meta. Recorded as an OUTBOUND message in the thread so the conversation stays whole. Our own
 *  sends are deduped away (we already recorded them) and confirmed against the delivery ledger. */
export interface IncomingEchoJob {
  platform: string;
  pageId: string;
  eventKey?: string;
  /** The user the page messaged (recipient of the echoed message) — the thread this belongs to. */
  recipientId: string;
  /** Platform-native id of the echoed message. */
  mid: string;
  text: string | null;
  timestamp: number;
}

/** THREADSYNC1: a Messenger delivery/read receipt — marks our OUTBOUND messages delivered/seen in the
 *  thread. `watermark` (epoch ms) = everything up to it is delivered/read; `mids` (delivery only) are
 *  specific delivered message ids. */
export interface IncomingReceiptJob {
  platform: string;
  pageId: string;
  eventKey?: string;
  /** The user who received/read our messages — identifies the conversation. */
  userId: string;
  kind: "delivered" | "read";
  watermark: number;
  mids?: string[];
}

/** Comment-to-DM: a private reply addressed by comment_id (first-touch DM). */
export interface OutgoingPrivateReplyJob extends FirstResponseStamp {
  channelId: string;
  conversationId: string;
  /** The addressed contact — stamped on the delivery ledger so erasure cascades + the queue
   *  PII scrub reaches private-reply jobs too. */
  contactId: string;
  commentId: string;
  /** Plain-text preview, persisted to the message row. */
  text: string;
  /** Full interactive content (quick replies / buttons). Falls back to `text` when absent. */
  content?: MessageContent;
  sentByRuleId?: string;
  idempotencyKey?: string;
  /** Set when draining a parked private reply: update this held row in place instead of inserting a new one. */
  heldMessageId?: string;
}

export interface IncomingCommentJob {
  platform: string;
  /** The FB Page ID that received the comment */
  pageId: string;
  /** webhook_events.event_key the edge logged this event under (worker fire-claim CAS key). */
  eventKey?: string;
  commentId: string;
  /** Post ID (Facebook) or Media ID (Instagram) */
  postId: string | undefined;
  senderId: string | undefined;
  senderName: string | undefined;
  text: string | undefined;
  timestamp: number | undefined;
}

/** Emoji reaction to one of our messages (Messenger/IG `reaction` event). */
export interface IncomingReactionJob {
  platform: string;
  pageId: string;
  /** webhook_events.event_key the edge logged this event under (worker fire-claim CAS key). */
  eventKey?: string;
  /** Reactor's platform-native id (PSID / IG user id) */
  senderId: string;
  /** Message id that was reacted to */
  reactedMid: string;
  /** Semantic reaction type (love, like, wow, ...) */
  reactionType: string | undefined;
  emoji: string | undefined;
  timestamp: number | undefined;
}

/** A reaction/like left on one of our posts (Facebook page feed). Recorded for the engagement
 *  view; no reply is sent. An unreact arrives with verb="remove" so the worker deletes the row. */
export interface IncomingPostReactionJob {
  platform: string;
  pageId: string;
  eventKey?: string;
  postId: string;
  reactorId: string;
  reactorName?: string;
  /** "like" for a plain like, or the reaction name (love, wow, …). */
  reactionType: string;
  verb: "add" | "remove";
  timestamp?: number;
}

export interface OutgoingMessageJob extends FirstResponseStamp {
  channelId: string;
  conversationId: string;
  contactId: string;
  /** Platform-native recipient ID */
  recipientPlatformId: string;
  content: MessageContent;
  sentByRuleId?: string;
  sentByUserId?: string;
  /** True for a human operator's manual reply. The human-agent exemption (consent re-check skip +
   *  send-while-paused) keys on THIS, not sentByUserId — because an API-key reply nulls sentByUserId
   *  (it's a users.id FK and "api-key:<id>" isn't a UUID) yet is still a human action. */
  isManual?: boolean;
  /** Unique key to prevent duplicate sends on retry. Generated at enqueue time. */
  idempotencyKey?: string;
  /** Set when draining a parked message: update this held row in place instead of inserting a new one. */
  heldMessageId?: string;
}

export interface TokenRefreshJob {
  channelId: string;
}

/** Publish a scheduled delivery (the AUD27 crash-safe publish worker). */
export interface PublishJob {
  postId: string;
}

export interface SequenceStepJob {
  enrollmentId: string;
  /** TIMING2: present only on the step-0 job scheduled at enrollment, carrying the inbound trigger's
   *  identity. The worker stamps it onto the FIRST sequence message (a step-0 `message`) so the
   *  delivery can measure first-response latency; subsequent step jobs omit it (never measured). */
  triggerEventId?: string;
  triggerReceivedAt?: string;
}

export interface DrainChannelJob {
  channelId: string;
}

/** Resume every active+due drip enrollment on a channel after it's un-paused — runs in the
 *  background (keyset-paged) so the unpause request doesn't fan out an add_job per enrollment
 *  inside its own transaction at scale. */
export interface ResumeChannelEnrollmentsJob {
  channelId: string;
}

/**
 * Follow-gate: on a tap, re-check whether the user follows the business and
 * send the gated content accordingly (the lead magnet when they follow, a
 * re-prompt otherwise). Stateless — each tap re-checks live.
 */
export interface FollowGateJob extends FirstResponseStamp {
  channelId: string;
  conversationId: string;
  contactId: string;
  recipientPlatformId: string;
  /** Sent when the user follows the business (e.g. the resource link). */
  followed: MessageContent;
  /** Sent when the user does not follow yet (re-prompt + claim button). */
  notFollowed: MessageContent;
  sentByRuleId?: string;
  idempotencyKey?: string;
}

/** graphile-worker task identifiers → their payload type. */
export type TaskPayloadMap = {
  "incoming-message": IncomingMessageJob;
  "incoming-comment": IncomingCommentJob;
  "incoming-reaction": IncomingReactionJob;
  "incoming-post-reaction": IncomingPostReactionJob;
  "outgoing-message": OutgoingMessageJob;
  "outgoing-comment": OutgoingCommentJob;
  "outgoing-first-comment": OutgoingFirstCommentJob;
  "publish-story": PublishStoryJob;
  "incoming-echo": IncomingEchoJob;
  "incoming-receipt": IncomingReceiptJob;
  "outgoing-private-reply": OutgoingPrivateReplyJob;
  "follow-gate": FollowGateJob;
  "token-refresh": TokenRefreshJob;
  "sequence-step": SequenceStepJob;
  "drain-channel": DrainChannelJob;
  "resume-channel-enrollments": ResumeChannelEnrollmentsJob;
  publish: PublishJob;
};

export type TaskName = keyof TaskPayloadMap;

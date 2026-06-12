import type { MessageContent } from "@/lib/platforms/base";

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

export interface OutgoingCommentJob {
  channelId: string;
  /** The addressed contact — stamped on the delivery ledger so erasure cascades + the queue
   *  PII scrub reach the (personalized) public-reply text too. */
  contactId: string;
  commentId: string;
  text: string;
  sentByRuleId?: string;
  idempotencyKey?: string;
}

/** Comment-to-DM: a private reply addressed by comment_id (first-touch DM). */
export interface OutgoingPrivateReplyJob {
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

export interface OutgoingMessageJob {
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

export interface SequenceStepJob {
  enrollmentId: string;
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
export interface FollowGateJob {
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
  "outgoing-private-reply": OutgoingPrivateReplyJob;
  "follow-gate": FollowGateJob;
  "token-refresh": TokenRefreshJob;
  "sequence-step": SequenceStepJob;
  "drain-channel": DrainChannelJob;
  "resume-channel-enrollments": ResumeChannelEnrollmentsJob;
};

export type TaskName = keyof TaskPayloadMap;

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
  /** Full raw messaging event object from Meta */
  raw: Record<string, unknown>;
}

export interface OutgoingCommentJob {
  channelId: string;
  commentId: string;
  text: string;
  sentByRuleId?: string;
  idempotencyKey?: string;
}

/** Comment-to-DM: a private reply addressed by comment_id (first-touch DM). */
export interface OutgoingPrivateReplyJob {
  channelId: string;
  conversationId: string;
  commentId: string;
  /** Plain-text preview, persisted to the message row. */
  text: string;
  /** Full interactive content (quick replies / buttons). Falls back to `text` when absent. */
  content?: MessageContent;
  sentByRuleId?: string;
  idempotencyKey?: string;
}

export interface IncomingCommentJob {
  platform: string;
  /** The FB Page ID that received the comment */
  pageId: string;
  commentId: string;
  /** Post ID (Facebook) or Media ID (Instagram) */
  postId: string | undefined;
  senderId: string | undefined;
  senderName: string | undefined;
  text: string | undefined;
  timestamp: number | undefined;
  raw: Record<string, unknown>;
}

/** Emoji reaction to one of our messages (Messenger/IG `reaction` event). */
export interface IncomingReactionJob {
  platform: string;
  pageId: string;
  /** Reactor's platform-native id (PSID / IG user id) */
  senderId: string;
  /** Message id that was reacted to */
  reactedMid: string;
  /** Semantic reaction type (love, like, wow, ...) */
  reactionType: string | undefined;
  emoji: string | undefined;
  timestamp: number | undefined;
  raw: Record<string, unknown>;
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
  /** Unique key to prevent duplicate sends on retry. Generated at enqueue time. */
  idempotencyKey?: string;
  /** Set when draining a parked message: update this held row in place instead of inserting a new one (REL5). */
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
  "outgoing-message": OutgoingMessageJob;
  "outgoing-comment": OutgoingCommentJob;
  "outgoing-private-reply": OutgoingPrivateReplyJob;
  "follow-gate": FollowGateJob;
  "token-refresh": TokenRefreshJob;
  "sequence-step": SequenceStepJob;
  "drain-channel": DrainChannelJob;
};

export type TaskName = keyof TaskPayloadMap;

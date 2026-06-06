export interface IncomingMessageJob {
  /** "facebook" | "instagram" */
  platform: string;
  /** The FB Page ID / IG Account ID that received the message */
  pageId: string;
  /** Platform-native sender PSID / IG user ID */
  senderId: string;
  recipientId: string;
  /** Platform message ID — used for deduplication */
  mid: string;
  text: string | null;
  quickReplyPayload?: string;
  postbackPayload?: string;
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
  text: string;
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

export interface OutgoingMessageJob {
  channelId: string;
  conversationId: string;
  contactId: string;
  /** Platform-native recipient ID */
  recipientPlatformId: string;
  content: {
    text?: string;
    attachments?: Array<{ type: string; url: string }>;
    quick_replies?: Array<{ title: string; payload: string }>;
  };
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

/** graphile-worker task identifiers → their payload type. */
export type TaskPayloadMap = {
  "incoming-message": IncomingMessageJob;
  "incoming-comment": IncomingCommentJob;
  "outgoing-message": OutgoingMessageJob;
  "outgoing-comment": OutgoingCommentJob;
  "outgoing-private-reply": OutgoingPrivateReplyJob;
  "token-refresh": TokenRefreshJob;
  "sequence-step": SequenceStepJob;
  "drain-channel": DrainChannelJob;
};

export type TaskName = keyof TaskPayloadMap;

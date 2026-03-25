export interface IncomingMessageJob {
  channelId: string;
  event: Record<string, unknown>;
  platform: string;
  receivedAt: string;
}

export interface IncomingCommentJob {
  channelId: string;
  change: Record<string, unknown>;
  receivedAt: string;
}

export interface OutgoingMessageJob {
  channelId: string;
  conversationId: string;
  contactId: string;
  content: {
    text?: string;
    attachments?: Array<{ type: string; url: string }>;
    quick_replies?: Array<{ title: string; payload: string }>;
  };
  sentByRuleId?: string;
  sentByFlowId?: string;
  sentByUserId?: string;
}

export interface TokenRefreshJob {
  channelId: string;
}

export interface SequenceStepJob {
  enrollmentId: string;
}

export type QueueName =
  | "incoming-messages"
  | "incoming-comments"
  | "outgoing-messages"
  | "token-refresh"
  | "sequence-steps";

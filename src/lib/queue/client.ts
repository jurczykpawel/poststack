import { Queue } from "bullmq";
import { redis } from "@/lib/redis";
import type {
  IncomingMessageJob,
  IncomingCommentJob,
  OutgoingMessageJob,
  OutgoingCommentJob,
  TokenRefreshJob,
  SequenceStepJob,
} from "./types";

const defaultJobOptions = {
  removeOnComplete: 500,
  removeOnFail: 1000,
};

// Lazy-init queues to avoid Redis connection during next build prerendering.
// BullMQ Queue constructor immediately pings Redis, which fails in Docker build.

function lazyQueue<T>(name: string, opts?: Record<string, unknown>) {
  let q: Queue<T> | null = null;
  return new Proxy({} as Queue<T>, {
    get(_target, prop) {
      if (!q) {
        q = new Queue<T>(name, {
          connection: redis,
          defaultJobOptions: { ...defaultJobOptions, ...opts },
        });
      }
      return (q as unknown as Record<string, unknown>)[prop as string];
    },
  });
}

export const incomingMessagesQueue = lazyQueue<IncomingMessageJob>("incoming-messages");

export const incomingCommentsQueue = lazyQueue<IncomingCommentJob>("incoming-comments");

export const outgoingMessagesQueue = lazyQueue<OutgoingMessageJob>("outgoing-messages", {
  attempts: 3,
  backoff: { type: "exponential", delay: 5000 },
});

export const outgoingCommentsQueue = lazyQueue<OutgoingCommentJob>("outgoing-comments", {
  attempts: 3,
  backoff: { type: "exponential", delay: 5000 },
});

export const tokenRefreshQueue = lazyQueue<TokenRefreshJob>("token-refresh");

export const sequenceStepsQueue = lazyQueue<SequenceStepJob>("sequence-steps", {
  attempts: 3,
  backoff: { type: "fixed", delay: 10000 },
});

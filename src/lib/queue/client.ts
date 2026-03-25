import { Queue } from "bullmq";
import { redis } from "@/lib/redis";
import type {
  IncomingMessageJob,
  IncomingCommentJob,
  OutgoingMessageJob,
  TokenRefreshJob,
  SequenceStepJob,
} from "./types";

const defaultJobOptions = {
  removeOnComplete: 500,
  removeOnFail: 1000,
};

export const incomingMessagesQueue = new Queue<IncomingMessageJob>(
  "incoming-messages",
  {
    connection: redis,
    defaultJobOptions,
  }
);

export const incomingCommentsQueue = new Queue<IncomingCommentJob>(
  "incoming-comments",
  {
    connection: redis,
    defaultJobOptions,
  }
);

export const outgoingMessagesQueue = new Queue<OutgoingMessageJob>(
  "outgoing-messages",
  {
    connection: redis,
    defaultJobOptions: {
      ...defaultJobOptions,
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
    },
  }
);

export const tokenRefreshQueue = new Queue<TokenRefreshJob>("token-refresh", {
  connection: redis,
  defaultJobOptions,
});

export const sequenceStepsQueue = new Queue<SequenceStepJob>("sequence-steps", {
  connection: redis,
  defaultJobOptions: {
    ...defaultJobOptions,
    attempts: 3,
    backoff: { type: "fixed", delay: 10000 },
  },
});

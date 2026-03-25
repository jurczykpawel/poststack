/**
 * ReplyStack BullMQ Worker
 *
 * Run with: npm run worker
 * In production: separate Docker container using Dockerfile.worker
 */

import { Worker, type Job } from "bullmq";
import Redis from "ioredis";

// Load env before anything else
const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) throw new Error("REDIS_URL is required");

const connection = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

// --- Workers ---

const incomingWorker = new Worker(
  "incoming-messages",
  async (job: Job) => {
    const { processIncomingMessage } = await import(
      "../src/lib/workers/incoming-message-worker"
    );
    return processIncomingMessage(job.data);
  },
  {
    connection,
    concurrency: 10,
    lockDuration: 30_000,
  }
);

const incomingCommentsWorker = new Worker(
  "incoming-comments",
  async (job: Job) => {
    const { processIncomingComment } = await import(
      "../src/lib/workers/incoming-comment-worker"
    );
    return processIncomingComment(job.data);
  },
  {
    connection,
    concurrency: 5,
    lockDuration: 30_000,
  }
);

const outgoingWorker = new Worker(
  "outgoing-messages",
  async (job: Job) => {
    const { processOutgoingMessage } = await import(
      "../src/lib/workers/outgoing-message-worker"
    );
    return processOutgoingMessage(job.data);
  },
  {
    connection,
    concurrency: 5,
    lockDuration: 60_000,
  }
);

const tokenRefreshWorker = new Worker(
  "token-refresh",
  async (job: Job) => {
    const { processTokenRefresh } = await import(
      "../src/lib/workers/token-refresh-worker"
    );
    return processTokenRefresh(job.data);
  },
  {
    connection,
    concurrency: 3,
    lockDuration: 30_000,
  }
);

const sequenceStepsWorker = new Worker(
  "sequence-steps",
  async (job: Job) => {
    const { processSequenceStep } = await import(
      "../src/lib/workers/sequence-step-worker"
    );
    return processSequenceStep(job.data);
  },
  {
    connection,
    concurrency: 5,
    lockDuration: 60_000,
  }
);

const workers = [
  incomingWorker,
  incomingCommentsWorker,
  outgoingWorker,
  tokenRefreshWorker,
  sequenceStepsWorker,
];

// --- Error handlers ---

workers.forEach((worker) => {
  worker.on("failed", (job, err) => {
    console.error(`[worker:${worker.name}] Job ${job?.id} failed:`, err.message);
  });

  worker.on("error", (err) => {
    console.error(`[worker:${worker.name}] Worker error:`, err);
  });
});

console.log(`[worker] ReplyStack worker started. Listening on ${workers.length} queues.`);

// --- Graceful shutdown ---

async function shutdown() {
  console.log("[worker] Shutting down...");
  await Promise.all(workers.map((w) => w.close()));
  await connection.quit();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

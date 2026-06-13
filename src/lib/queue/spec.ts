import type { TaskSpec } from "graphile-worker";
import type { TaskName } from "./types";

/**
 * Per-task retry count. Every task type retries transient failures with
 * graphile-worker's exponential backoff. Permanent failures (e.g. an invalid
 * token) are classified by the workers and returned without throwing, so they
 * do not consume retries. A job that exhausts these attempts is
 * retained by graphile as a permanently-failed (dead-letter) row.
 */
export const TASK_MAX_ATTEMPTS: Record<TaskName, number> = {
  "incoming-message": 3,
  "incoming-comment": 3,
  "incoming-reaction": 3,
  "incoming-post-reaction": 3,
  "outgoing-message": 3,
  "outgoing-comment": 3,
  "outgoing-private-reply": 3,
  "follow-gate": 3,
  "token-refresh": 3,
  "sequence-step": 3,
  "drain-channel": 3,
  "resume-channel-enrollments": 3,
  // AUD27 publish worker manages its own state machine (claim/defer/reconcile); a generous attempt
  // budget covers transient pre_commit retries without the row being abandoned by graphile.
  publish: 10,
};

export interface AddJobOptions {
  /** Dedup key — replaces an existing pending job with the same key (was BullMQ `jobId`). */
  jobKey?: string;
  /** Delay before the job becomes runnable, in milliseconds (was BullMQ `delay`). */
  delayMs?: number;
  /** Override the per-task default retry count. */
  maxAttempts?: number;
}

export function buildTaskSpec(
  taskName: TaskName,
  opts: AddJobOptions = {},
  now: Date = new Date(),
): TaskSpec {
  const spec: TaskSpec = {
    maxAttempts: opts.maxAttempts ?? TASK_MAX_ATTEMPTS[taskName],
  };
  if (opts.jobKey) spec.jobKey = opts.jobKey;
  if (opts.delayMs && opts.delayMs > 0) {
    spec.runAt = new Date(now.getTime() + opts.delayMs);
  }
  return spec;
}

import type { TaskSpec } from "graphile-worker";
import type { TaskName } from "./types";

/**
 * Per-task retry count, preserving the former BullMQ queue configuration.
 * outgoing-* and sequence-step had `attempts: 3`; the rest had none (= 1).
 */
export const TASK_MAX_ATTEMPTS: Record<TaskName, number> = {
  "incoming-message": 1,
  "incoming-comment": 1,
  "outgoing-message": 3,
  "outgoing-comment": 3,
  "token-refresh": 1,
  "sequence-step": 3,
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

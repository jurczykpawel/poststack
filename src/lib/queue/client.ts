import { makeWorkerUtils, type WorkerUtils } from "graphile-worker";
import { sql, type SQL } from "drizzle-orm";
import { buildTaskSpec, TASK_MAX_ATTEMPTS, type AddJobOptions } from "./spec";
import type { TaskName, TaskPayloadMap } from "./types";

/** Anything that can run `.execute` — a Drizzle db or an open transaction. */
type TxExecutor = { execute: (query: SQL) => Promise<unknown> };

// Lazy singleton: graphile-worker opens its own pg pool. Initialising on first
// use (not at import) keeps `next build` from connecting during prerender.
let workerUtilsPromise: Promise<WorkerUtils> | null = null;

function getWorkerUtils(): Promise<WorkerUtils> {
  if (!workerUtilsPromise) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required");
    workerUtilsPromise = makeWorkerUtils({ connectionString });
  }
  return workerUtilsPromise;
}

/** Enqueue a job for the worker process. PG-backed (graphile-worker). */
export async function addJob<T extends TaskName>(
  taskName: T,
  payload: TaskPayloadMap[T],
  opts?: AddJobOptions,
): Promise<void> {
  const utils = await getWorkerUtils();
  // Widen the generic `T` to the concrete TaskName union so graphile's own
  // generic resolves; the public signature above keeps payload type-checked.
  await utils.addJob(taskName as TaskName, payload, buildTaskSpec(taskName, opts));
}

/**
 * Enqueue a job inside the caller's transaction via `graphile_worker.add_job`, so the
 * job is committed atomically with the surrounding DB writes (a transactional outbox).
 * If the transaction rolls back, the job is never enqueued — and vice versa. Use this
 * when a job must not exist without its side effects (or its limits) and back.
 */
export async function addJobTx<T extends TaskName>(
  tx: TxExecutor,
  taskName: T,
  payload: TaskPayloadMap[T],
  opts: { jobKey?: string; maxAttempts?: number } = {},
): Promise<void> {
  const maxAttempts = opts.maxAttempts ?? TASK_MAX_ATTEMPTS[taskName];
  await tx.execute(sql`
    select graphile_worker.add_job(
      ${taskName},
      ${JSON.stringify(payload)}::json,
      max_attempts => ${maxAttempts},
      job_key => ${opts.jobKey ?? null}
    )
  `);
}

/** Release the WorkerUtils pool. For graceful shutdown and tests. */
export async function closeQueue(): Promise<void> {
  if (workerUtilsPromise) {
    const utils = await workerUtilsPromise;
    await utils.release();
    workerUtilsPromise = null;
  }
}

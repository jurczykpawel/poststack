import { makeWorkerUtils, type WorkerUtils } from "graphile-worker";
import { buildTaskSpec, type AddJobOptions } from "./spec";
import type { TaskName, TaskPayloadMap } from "./types";

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

/** Release the WorkerUtils pool. For graceful shutdown and tests. */
export async function closeQueue(): Promise<void> {
  if (workerUtilsPromise) {
    const utils = await workerUtilsPromise;
    await utils.release();
    workerUtilsPromise = null;
  }
}

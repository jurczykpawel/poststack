import { makeWorkerUtils } from "graphile-worker";

/**
 * Global setup for the integration suite. Installs the `graphile_worker` schema once against the
 * shared TEST_DATABASE_URL before any test file runs. Since emitEvent now enqueues an event-dispatch
 * job transactionally (WHOUT1), any test that emits an event — or creates a contact, publishes a
 * post, transitions a channel — needs the queue schema present, even if it never inspects the queue.
 * Doing it once here removes the per-suite `makeWorkerUtils().migrate()` boilerplate and the
 * file-ordering fragility of relying on whichever suite happens to migrate first.
 */
export default async function setup(): Promise<void> {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) return; // integration suites self-skip without a DB
  const utils = await makeWorkerUtils({ connectionString });
  try {
    await utils.migrate();
  } finally {
    await utils.release();
  }
}

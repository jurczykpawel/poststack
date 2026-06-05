/**
 * ReplyStack worker (graphile-worker)
 *
 * Run with: npm run worker
 * In production: separate Docker container using Dockerfile.worker
 *
 * Consumes jobs from PostgreSQL (graphile-worker). `run()` installs the
 * graphile_worker schema on startup and installs SIGINT/SIGTERM handlers for
 * graceful shutdown.
 */

import { run } from "graphile-worker";
import { createTaskList } from "../src/lib/queue/tasks";
import { pruneExpired } from "../src/lib/maintenance";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

async function main() {
  const taskList = {
    ...createTaskList(),
    // Cron-only maintenance task (not enqueued via addJob).
    "prune-expired": async () => {
      await pruneExpired();
    },
  };

  const runner = await run({
    connectionString,
    concurrency: 10,
    taskList,
    // Hourly cleanup of expired ephemeral rows (denylist, cooldowns, idempotency).
    crontab: "0 * * * * prune-expired",
  });

  console.log(
    `[worker] ReplyStack worker started. Tasks: ${Object.keys(taskList).join(", ")}`
  );

  // Dead-letter visibility: a job that exhausts all attempts is retained by
  // graphile (queryable) — surface it in logs instead of failing silently.
  runner.events.on("job:failed", ({ job, error }) => {
    if (job.attempts >= job.max_attempts) {
      const reason = job.last_error ?? (error instanceof Error ? error.message : String(error));
      console.error(
        `[worker] dead-letter: task=${job.task_identifier} job=${job.id} exhausted ${job.max_attempts} attempts: ${reason}`
      );
    }
  });

  await runner.promise;
}

main().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});

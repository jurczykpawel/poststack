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

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

async function main() {
  const taskList = createTaskList();
  const runner = await run({
    connectionString,
    concurrency: 10,
    taskList,
  });

  console.log(
    `[worker] ReplyStack worker started. Tasks: ${Object.keys(taskList).join(", ")}`
  );

  await runner.promise;
}

main().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});

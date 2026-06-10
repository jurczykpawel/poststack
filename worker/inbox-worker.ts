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

import { writeFileSync } from "fs";
import { run } from "graphile-worker";
import { createTaskList } from "../src/lib/queue/tasks";
import { cronTaskList, CRONTAB } from "../src/lib/workers/cron";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

// Liveness heartbeat. `restart: always` recovers a CRASHED worker, but a HUNG one (blocked
// event loop, dead pool) stays "running" and invisible — Docker, the operator and alerting see
// nothing. graphile fires worker:getJob:* on every poll, even while idle, so we advance an in-memory
// timestamp on those events ("the worker loop is alive and polling") and a separate timer flushes it
// to a file the container healthcheck reads. If polling stops, the file stops advancing → unhealthy.
const HEARTBEAT_FILE = process.env.WORKER_HEARTBEAT_FILE ?? "/tmp/replystack-worker.heartbeat";
let lastActivityMs = Date.now();

async function main() {
  const taskList = {
    ...createTaskList(),
    ...cronTaskList,
  };

  const runner = await run({
    connectionString,
    concurrency: 10,
    taskList,
    crontab: CRONTAB,
  });

  console.log(
    `[worker] ReplyStack worker started. Tasks: ${Object.keys(taskList).join(", ")}`
  );

  const noteActivity = () => { lastActivityMs = Date.now(); };
  // Tick only on evidence the worker SUCCESSFULLY reached the DB, never on a poll attempt:
  // `worker:getJob:empty` fires after a poll query that found no work (healthy idle), and a job
  // completing proves a round-trip too. `worker:getJob:start` fires BEFORE the query, so a dead pool
  // (start → query throws → error → reschedule → start …) would keep ticking and falsely read healthy
  // — the exact failure mode this probe must catch.
  runner.events.on("worker:getJob:empty", noteActivity); // poll reached the DB, no work
  runner.events.on("job:success", noteActivity);
  runner.events.on("job:failed", noteActivity);
  // Flush the LAST-polled timestamp (not "now"): if graphile stops polling, the file freezes even
  // though this timer keeps running, so `now - heartbeat` grows and the healthcheck trips.
  const flushHeartbeat = () => {
    try {
      writeFileSync(HEARTBEAT_FILE, String(Math.floor(lastActivityMs / 1000)));
    } catch {
      /* best effort — a missing heartbeat file simply reads as stale → unhealthy */
    }
  };
  flushHeartbeat();
  setInterval(flushHeartbeat, 10_000).unref();

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

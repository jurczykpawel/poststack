/**
 * PostStack worker (graphile-worker)
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
import { db } from "../src/lib/db";
import { sendTelemetryOnBoot } from "../src/lib/telemetry/send";
import { WorkerHeartbeat } from "./heartbeat";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

// Liveness heartbeat. `restart: always` recovers a CRASHED worker, but a HUNG one (blocked
// event loop, dead pool) stays "running" and invisible — Docker, the operator and alerting see
// nothing. Successful idle polls prove DB connectivity; active jobs plus this file-flush timer prove
// the event loop is responsive. If neither is true, the file stops advancing → unhealthy.
const HEARTBEAT_FILE = process.env.WORKER_HEARTBEAT_FILE ?? "/tmp/replystack-worker.heartbeat";
const heartbeat = new WorkerHeartbeat();

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
    `[worker] PostStack worker started. Tasks: ${Object.keys(taskList).join(", ")}`
  );

  // Anonymous usage telemetry: log the enabled notice and fire a debounced boot send (fire-and-forget,
  // never blocks startup). No-op when telemetry is disabled.
  void sendTelemetryOnBoot(db);

  // Never advance on `worker:getJob:start`: it fires before the database query. `job:start` means a
  // job was fetched successfully; `job:complete` is emitted after its result was persisted.
  runner.events.on("worker:getJob:empty", () => heartbeat.databaseReached());
  runner.events.on("job:start", () => heartbeat.jobStarted());
  runner.events.on("job:complete", () => heartbeat.jobCompleted());

  const flushHeartbeat = () => {
    try {
      writeFileSync(HEARTBEAT_FILE, String(heartbeat.timestampSeconds()));
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

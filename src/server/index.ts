import { serve } from "@hono/node-server";
import { buildApp } from "./app";
import { closeQueue } from "@/lib/queue/client";

const port = Number(process.env.PORT) || 3000;

const server = serve({ fetch: buildApp().fetch, port }, (info) => {
  console.log(`[server] ReplyStack listening on http://localhost:${info.port}`);
});

// Graceful shutdown. On deploy/stop the orchestrator sends SIGTERM; without a handler the
// process is killed mid-flight, dropping in-flight requests — including a webhook between its 200 and
// its `addJob` enqueue (a dropped webhook means a delayed Meta redelivery). Stop accepting new
// connections, let outstanding requests finish (bounded by a grace timeout), release the queue pool,
// then exit. The worker process has its own graphile-managed graceful shutdown.
const SHUTDOWN_GRACE_MS = Number(process.env.SHUTDOWN_GRACE_MS) || 10_000;
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received — draining in-flight requests`);
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      console.warn("[server] shutdown grace elapsed — forcing exit");
      resolve();
    }, SHUTDOWN_GRACE_MS);
    server.close((err) => {
      clearTimeout(timer);
      if (err) console.error("[server] error closing HTTP server:", err);
      resolve();
    });
  });
  await closeQueue().catch((err) => console.error("[server] error releasing queue pool:", err));
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

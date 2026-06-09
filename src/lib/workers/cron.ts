import { pruneExpired } from "@/lib/maintenance";
import { pruneOldMessages } from "@/lib/retention";
import { scanExpiringTokens } from "@/lib/workers/token-refresh-scan";

/**
 * Cron-only maintenance tasks. These are NOT enqueued via addJob — graphile-worker drives them
 * from the {@link CRONTAB} schedule below. Kept here (not inline in the worker entrypoint) so the
 * schedule is unit-testable and the entrypoint stays a thin bootstrap.
 */
export const cronTaskList = {
  // Hourly cleanup of expired ephemeral rows (denylist, cooldowns, idempotency, old dedup keys).
  "prune-expired": async () => {
    await pruneExpired();
  },
  // Daily message retention prune (workspaces with a retention policy).
  "prune-old-messages": async () => {
    await pruneOldMessages();
  },
  // Hourly token-refresh scan. Self-contained so the refresh cycle does not depend on an external
  // caller hitting GET /api/cron/token-refresh — a self-hoster following `docker compose up` would
  // never wire that, and every OAuth channel would silently expire in ~60 days. The HTTP
  // endpoint stays available for a manual trigger.
  "token-refresh-scan": async () => {
    await scanExpiringTokens();
  },
};

/** graphile-worker crontab. Every line's trailing token must be a key in {@link cronTaskList}. */
export const CRONTAB = [
  "0 * * * * prune-expired",
  "30 3 * * * prune-old-messages",
  "15 * * * * token-refresh-scan",
].join("\n");

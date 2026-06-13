import { pruneExpired } from "@/lib/maintenance";
import { pruneOldMessages } from "@/lib/retention";
import { scanExpiringTokens } from "@/lib/workers/token-refresh-scan";
import { refreshLicense } from "@/lib/license/gate";
import { enforceApiKeyLicense } from "@/lib/license/api-key-enforcement";
import { sweepAccountSources } from "@/lib/channels/account-source";
import { sweepChannelHealth } from "@/lib/channels/health-sweep";
import { scanExpiringConnections } from "@/lib/channels/expiry-scan";

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
  // Daily license re-verification. Catches expiry/revocation and refreshes the seller JWKS
  // snapshot so an offline instance keeps a usable fallback. No-op (writes "none") when unlicensed.
  "license-refresh": async () => {
    await refreshLicense();
    // PRO-gate API access on the existing keys: a downgrade (refund/expiry) expires them so they
    // stop authenticating. Creation is gated separately at the route.
    await enforceApiKeyLicense();
  },
  // Daily managed-connection sync: re-enumerate each active source so newly-added Pages/IG appear
  // automatically and a reconnected master recovers. No-op when there are no managed sources.
  "source-sync-sweep": async () => {
    await sweepAccountSources();
  },
  // Hourly channel health check: trip needs_reauth on a confirmed-bad Meta token before it
  // dead-letters the next send (and surface it in the panel + an alert).
  "channel-health-sweep": async () => {
    await sweepChannelHealth();
  },
  // Daily proactive expiry scan: warn 7 days before a managed connection's 90-day data-access wall.
  "managed-expiry-scan": async () => {
    await scanExpiringConnections();
  },
};

/** graphile-worker crontab. Every line's trailing token must be a key in {@link cronTaskList}. */
export const CRONTAB = [
  "0 * * * * prune-expired",
  "30 3 * * * prune-old-messages",
  "15 * * * * token-refresh-scan",
  "45 3 * * * license-refresh",
  "0 4 * * * source-sync-sweep",
  "20 * * * * channel-health-sweep",
  "30 4 * * * managed-expiry-scan",
].join("\n");

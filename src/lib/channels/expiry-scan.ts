import { and, eq, isNotNull, lte } from "drizzle-orm";
import { db } from "@/lib/db";
import { accountSources } from "@/db/schema";
import { dispatchAlert } from "@/lib/notifications/alert";

/** Proactively warn this many days before a managed connection's data-access wall is reached. */
export const EXPIRY_WARNING_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Proactive expiry scan (PRO managed connection): find active sources whose ~90-day data-access wall
 * falls inside the warning window and emit a `token_expiring` alert so the operator re-logs in BEFORE
 * the connection silently goes dark. Reads the plaintext `data_access_expires_at` column — no token
 * decryption. System User sources have no wall (NULL) and are never alerted (they're permanent).
 *
 * Alerts are throttled per source by dispatchAlert, so running daily inside the window is safe.
 */
export async function scanExpiringConnections(
  opts: { withinDays?: number; now?: Date } = {},
): Promise<{ alerted: number }> {
  const now = opts.now ?? new Date();
  const horizon = new Date(now.getTime() + (opts.withinDays ?? EXPIRY_WARNING_DAYS) * DAY_MS);

  const expiring = await db.query.accountSources.findMany({
    where: and(
      eq(accountSources.status, "active"),
      isNotNull(accountSources.data_access_expires_at),
      lte(accountSources.data_access_expires_at, horizon),
    ),
    columns: { id: true, workspace_id: true, display_name: true, data_access_expires_at: true },
  });

  let alerted = 0;
  for (const source of expiring) {
    const wall = source.data_access_expires_at!;
    const daysLeft = Math.max(0, Math.ceil((wall.getTime() - now.getTime()) / DAY_MS));
    await dispatchAlert({
      type: "token_expiring",
      sourceId: source.id,
      workspaceId: source.workspace_id,
      displayName: source.display_name,
      expiresAt: wall.toISOString(),
      daysLeft,
      detail:
        `Your Meta managed connection "${source.display_name ?? source.id}" loses data access in ` +
        `${daysLeft} day(s). Re-connect it (log in again) to keep it running — a token refresh alone ` +
        `does NOT reset this 90-day wall.`,
    });
    alerted++;
  }
  return { alerted };
}

import { isSafeAlertWebhookUrl } from "./webhook-url";
import { rateLimit } from "@/lib/api/rate-limit";

/** Alert classes carried on the `type` discriminator. A single outbound webhook receives them all;
 *  the operator routes by `type` on their side (Telegram / n8n / Slack). */
export type AlertType = "channel_reauth" | "delivery_failed" | "delivery_held" | "event_error";

export interface Alert {
  type: AlertType;
  /** The channel the alert concerns, when applicable (used for throttle scoping + payload). */
  channelId?: string;
  workspaceId?: string;
  platform?: string;
  displayName?: string | null;
  /** Human-readable reason / error detail. Never a secret. */
  detail?: string;
}

/** One alert per (type, channel) per this window — a dead channel emitting hundreds of failed
 *  deliveries collapses into a single alert per failure-class until the window rolls over. */
export const ALERT_THROTTLE_WINDOW_SECONDS = 15 * 60; // 15 minutes

/**
 * Whether this alert is currently suppressed by the throttle. The first alert of a given
 * (type, channel) in the window passes; the rest are dropped until the window rolls over. An alert
 * with no channel scopes the throttle by type alone. Best-effort: if the throttle store errors,
 * fail OPEN (allow the alert) — a missed suppression is better than a missed alert.
 */
async function isThrottled(alert: Alert): Promise<boolean> {
  const key = `alert:${alert.type}:${alert.channelId ?? "-"}`;
  try {
    const { allowed } = await rateLimit(key, 1, ALERT_THROTTLE_WINDOW_SECONDS);
    return !allowed;
  } catch {
    return false;
  }
}

/**
 * Dispatch an operational alert to the single configured outbound webhook (CHANNEL_ALERT_WEBHOOK_URL).
 * One webhook carries every alert class, discriminated by `type`; the operator points it at
 * Telegram / n8n / Slack. No-op when the env var is unset. Throttled per (type, channel) so a
 * persistent failure can't emit an alert storm. Best-effort: never throws — a failed alert must
 * never break the worker that raised it.
 */
export async function dispatchAlert(alert: Alert): Promise<void> {
  const url = process.env.CHANNEL_ALERT_WEBHOOK_URL;
  if (!url) return;
  // Defense-in-depth before the fetch: refuse a private/link-local target (e.g. cloud metadata),
  // even though env validation rejects one at boot (also covers runtime-set values).
  if (!isSafeAlertWebhookUrl(url)) {
    console.warn("CHANNEL_ALERT_WEBHOOK_URL points at a disallowed (private/link-local) host — skipping alert");
    return;
  }

  if (await isThrottled(alert)) return;

  const appUrl = process.env.APP_URL;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: alert.type,
        channel_id: alert.channelId,
        workspace_id: alert.workspaceId,
        platform: alert.platform,
        display_name: alert.displayName,
        detail: alert.detail,
        app_url: appUrl,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Best-effort — a failed notification must never break the worker.
  }
}

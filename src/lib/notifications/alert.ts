import { isSafeAlertWebhookUrl } from "./webhook-url";
import { rateLimit } from "@/lib/api/rate-limit";
import { getAlertWebhook } from "./alert-webhook";
import { buildAlertBody, type PlaceholderContext } from "./alert-customization";

/** Alert classes carried on the `type` discriminator. A single outbound webhook receives them all;
 *  the operator routes by `type` on their side (Telegram / n8n / Slack). */
export type AlertType =
  | "channel_reauth"
  | "delivery_failed"
  | "delivery_held"
  | "event_error"
  | "token_expiring"; // proactive: a managed connection / token nears its data-access wall or expiry

export interface Alert {
  type: AlertType;
  /** The channel the alert concerns, when applicable (used for throttle scoping + payload). */
  channelId?: string;
  /** The managed source the alert concerns (token_expiring on a master); scopes the throttle too. */
  sourceId?: string;
  workspaceId?: string;
  platform?: string;
  displayName?: string | null;
  /** Human-readable reason / error detail. Never a secret. */
  detail?: string;
  /** For token_expiring: when access ends + how many whole days remain (for templating/routing). */
  expiresAt?: string;
  daysLeft?: number;
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
  const key = `alert:${alert.type}:${alert.channelId ?? alert.sourceId ?? "-"}`;
  try {
    const { allowed } = await rateLimit(key, 1, ALERT_THROTTLE_WINDOW_SECONDS);
    return !allowed;
  } catch {
    return false;
  }
}

/** The standard alert body (every field the operator can select / template against). */
function standardBody(alert: Alert): Record<string, unknown> {
  return {
    type: alert.type,
    channel_id: alert.channelId,
    source_id: alert.sourceId,
    workspace_id: alert.workspaceId,
    platform: alert.platform,
    display_name: alert.displayName,
    detail: alert.detail,
    expires_at: alert.expiresAt,
    days_left: alert.daysLeft,
    app_url: process.env.APP_URL,
  };
}

/** Flatten the standard body into a {{placeholder}} context (string leaves only). */
function placeholderContext(body: Record<string, unknown>): PlaceholderContext {
  const ctx: PlaceholderContext = {};
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined || v === null) ctx[k] = "";
    else ctx[k] = String(v);
  }
  return ctx;
}

/**
 * Dispatch an operational alert. One webhook carries every alert class, discriminated by `type`.
 *
 * Resolution order:
 *  1. the alert's workspace has a configured + enabled `alert_webhooks` row → POST the customized
 *     body (field selection + {{placeholder}} extra fields) with its (decrypted) custom headers —
 *     so it can target your email service (SES/SMTP) / Slack / n8n. This is the PRO path.
 *  2. otherwise the global env `CHANNEL_ALERT_WEBHOOK_URL` (the ungated self-host fallback), plain body.
 *
 * Throttled per (type, channel|source) so a persistent failure can't storm. Best-effort: never
 * throws and refuses a private/link-local target — a failed alert must not break the worker.
 */
export async function dispatchAlert(alert: Alert): Promise<void> {
  const body = standardBody(alert);

  // Per-workspace customized webhook takes precedence over the env fallback.
  let target: { url: string; headers: Record<string, string>; payload: Record<string, unknown> } | null = null;
  if (alert.workspaceId) {
    try {
      const cfg = await getAlertWebhook(alert.workspaceId);
      if (cfg && cfg.enabled && cfg.url) {
        target = {
          url: cfg.url,
          headers: { "Content-Type": "application/json", ...cfg.headers },
          payload: buildAlertBody(body, { field_selection: cfg.fieldSelection, extra_payload_fields: cfg.extraFields }, placeholderContext(body)),
        };
      }
    } catch {
      // config read failed — fall through to the env fallback rather than dropping the alert.
    }
  }
  if (!target) {
    const url = process.env.CHANNEL_ALERT_WEBHOOK_URL;
    if (!url) return;
    target = { url, headers: { "Content-Type": "application/json" }, payload: body };
  }

  // Defense-in-depth before the fetch: refuse a private/link-local target (e.g. cloud metadata).
  if (!isSafeAlertWebhookUrl(target.url)) {
    console.warn("Alert webhook URL points at a disallowed (private/link-local) host — skipping alert");
    return;
  }

  if (await isThrottled(alert)) return;

  try {
    await fetch(target.url, {
      method: "POST",
      headers: target.headers,
      body: JSON.stringify(target.payload),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Best-effort — a failed notification must never break the worker.
  }
}

export interface ChannelDownAlert {
  workspaceId: string;
  channelId: string;
  platform: string;
  displayName: string | null;
  reason: string;
}

/**
 * Notify the operator that a channel needs re-authentication. Generic outbound
 * webhook — self-hosters pipe it to email / Slack / ntfy / n8n on their side.
 * No-op when `CHANNEL_ALERT_WEBHOOK_URL` is unset. Best-effort: never throws.
 */
export async function notifyChannelDown(alert: ChannelDownAlert): Promise<void> {
  const url = process.env.CHANNEL_ALERT_WEBHOOK_URL;
  if (!url) return;

  const appUrl = process.env.APP_URL;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "channel.needs_reauth",
        workspace_id: alert.workspaceId,
        channel_id: alert.channelId,
        platform: alert.platform,
        display_name: alert.displayName,
        reason: alert.reason,
        reauth_url: appUrl ? `${appUrl}/channels` : undefined,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Best-effort — a failed notification must never break the worker.
  }
}

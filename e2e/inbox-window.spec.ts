import { test, expect } from "@playwright/test";
import { Client } from "pg";
import { E2E_DATABASE_URL } from "./env";
import { gotoOk, setPro } from "./helpers";

// G30: a Meta DM past the 24h window cannot be answered by hand (Human Agent is not approved by default).
for (const [label, hoursAgo, closed] of [["closed", 30, true], ["open", 2, false]] as const) {
  test(`Inbox reply box is ${closed ? "disabled with the reason" : "usable"} when the 24h window is ${label}`, async ({ page }) => {
    await setPro(page.request);
    const client = new Client({ connectionString: E2E_DATABASE_URL });
    await client.connect();
    let channelId: string | undefined;
    try {
      const { rows: [ws] } = await client.query<{ id: string }>("SELECT id FROM workspaces ORDER BY created_at LIMIT 1");
      const { rows: [ch] } = await client.query<{ id: string }>(
        `INSERT INTO channels (workspace_id, platform, platform_id, display_name, token_encrypted, webhook_secret, status)
         VALUES ($1, 'instagram', $2, $2, 'x', 's', 'active') RETURNING id`, [ws.id, `win-${label}`]);
      channelId = ch.id;
      const { rows: [ct] } = await client.query<{ id: string }>(
        "INSERT INTO contacts (workspace_id, display_name) VALUES ($1, $2) RETURNING id", [ws.id, `Window ${label}`]);
      await client.query("INSERT INTO contact_channels (contact_id, channel_id, platform_sender_id) VALUES ($1, $2, $3)", [ct.id, channelId, `win-${label}`]);
      const { rows: [cv] } = await client.query<{ id: string }>(
        `INSERT INTO conversations (workspace_id, channel_id, contact_id, platform, last_message_at, last_inbound_at)
         VALUES ($1, $2, $3, 'instagram', now(), now() - ($4 || ' hours')::interval) RETURNING id`, [ws.id, channelId, ct.id, String(hoursAgo)]);
      await client.query(
        `INSERT INTO messages (conversation_id, direction, platform_message_id, text, created_at)
         VALUES ($1, 'inbound', $2, 'Hello there', now() - ($3 || ' hours')::interval)`, [cv.id, `win-${label}-1`, String(hoursAgo)]);
      await gotoOk(page, `/inbox?open=${cv.id}`);
      await expect(page.locator("#thread-msgs")).toContainText("Hello there");
      const send = page.getByRole("button", { name: "Send", exact: true });
      if (closed) {
        await expect(page.locator(".reply-bar textarea")).toBeDisabled();
        await expect(send).toBeDisabled();
        await expect(page.locator("#thread")).toContainText(/24h reply window closed/i);
        await expect(page.locator("#thread")).not.toContainText(/human-agent/i);
      } else {
        await expect(page.locator(".reply-bar textarea")).toBeEnabled();
        await expect(send).toBeEnabled();
      }
    } finally {
      if (channelId) await client.query("DELETE FROM channels WHERE id = $1", [channelId]);
      await client.end();
    }
  });
}

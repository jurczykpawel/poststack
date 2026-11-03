import { test, expect } from "@playwright/test";
import { Client } from "pg";
import { E2E_DATABASE_URL } from "./env";
import { gotoOk, setPro } from "./helpers";

// G34: a permanently failed outbound bubble shows the stored failure_reason (escaped); no reason keeps the generic text.
test("Inbox failed bubble shows the real failure_reason, falls back to generic text without one", async ({ page }) => {
  await setPro(page.request);
  const client = new Client({ connectionString: E2E_DATABASE_URL });
  await client.connect();
  let channelId: string | undefined;
  try {
    const { rows: [ws] } = await client.query<{ id: string }>("SELECT id FROM workspaces ORDER BY created_at LIMIT 1");
    const { rows: [ch] } = await client.query<{ id: string }>(
      `INSERT INTO channels (workspace_id, platform, platform_id, display_name, token_encrypted, webhook_secret, status)
       VALUES ($1, 'instagram', 'fr-g34', 'fr-g34', 'x', 's', 'active') RETURNING id`, [ws.id]);
    channelId = ch.id;
    const { rows: [ct] } = await client.query<{ id: string }>(
      "INSERT INTO contacts (workspace_id, display_name) VALUES ($1, 'Failed reason') RETURNING id", [ws.id]);
    await client.query("INSERT INTO contact_channels (contact_id, channel_id, platform_sender_id) VALUES ($1, $2, 'fr-g34')", [ct.id, channelId]);
    const { rows: [cv] } = await client.query<{ id: string }>(
      `INSERT INTO conversations (workspace_id, channel_id, contact_id, platform, last_message_at, last_inbound_at)
       VALUES ($1, $2, $3, 'instagram', now(), now()) RETURNING id`, [ws.id, channelId, ct.id]);
    await client.query(
      `INSERT INTO messages (conversation_id, direction, text, status, failure_reason, created_at) VALUES
       ($1, 'outbound', 'with reason', 'failed', '(#100) bad <b>recipient</b>', now() - interval '2 minutes'),
       ($1, 'outbound', 'no reason', 'failed', NULL, now() - interval '1 minute')`, [cv.id]);
    await gotoOk(page, `/inbox?open=${cv.id}`);
    const failed = page.locator("#thread-msgs .msg-failed");
    await expect(failed).toHaveCount(2);
    await expect(failed.nth(0)).toHaveText("Not delivered — (#100) bad <b>recipient</b>");
    await expect(page.locator("#thread-msgs b")).toHaveCount(0);
    await expect(failed.nth(1)).toContainText("the platform refused it");
    await page.screenshot({ path: "/private/tmp/g34-failed-reason.png", fullPage: true });
  } finally {
    if (channelId) await client.query("DELETE FROM channels WHERE id = $1", [channelId]);
    await client.end();
  }
});

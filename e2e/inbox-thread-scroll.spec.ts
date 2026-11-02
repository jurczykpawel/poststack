import { test, expect } from "@playwright/test";
import { Client } from "pg";
import { E2E_DATABASE_URL } from "./env";
import { gotoOk, setPro } from "./helpers";

// MQA13-B02: a long thread opens on its newest message, also after a poll, and a manual scroll survives it.
for (const [width, height] of [[1280, 600], [390, 844]]) {
  test(`Inbox thread opens at the newest message at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await setPro(page.request);
    const client = new Client({ connectionString: E2E_DATABASE_URL });
    await client.connect();
    let channelId: string | undefined;
    try {
      const { rows: [ws] } = await client.query<{ id: string }>("SELECT id FROM workspaces ORDER BY created_at LIMIT 1");
      const { rows: [ch] } = await client.query<{ id: string }>(
        `INSERT INTO channels (workspace_id, platform, platform_id, display_name, token_encrypted, webhook_secret, status)
         VALUES ($1, 'facebook', $2, $2, 'x', 's', 'active') RETURNING id`, [ws.id, `scroll-${width}`]);
      channelId = ch.id;
      const { rows: [ct] } = await client.query<{ id: string }>(
        "INSERT INTO contacts (workspace_id, display_name) VALUES ($1, $2) RETURNING id", [ws.id, `Scroll ${width}`]);
      await client.query("INSERT INTO contact_channels (contact_id, channel_id, platform_sender_id) VALUES ($1, $2, $3)", [ct.id, channelId, `scroll-${width}`]);
      const { rows: [cv] } = await client.query<{ id: string }>(
        `INSERT INTO conversations (workspace_id, channel_id, contact_id, platform, last_message_at)
         VALUES ($1, $2, $3, 'facebook', now()) RETURNING id`, [ws.id, channelId, ct.id]);
      for (let i = 0; i < 30; i++) {
        await client.query(
          `INSERT INTO messages (conversation_id, direction, platform_message_id, text, created_at)
           VALUES ($1, 'inbound', $2, $3, now() - ($4 || ' minutes')::interval)`, [cv.id, `scroll-${width}-${i}`, `Message ${i}`, String(60 - i)]);
      }
      await gotoOk(page, `/inbox?open=${cv.id}`);
      const msgs = page.locator("#thread-msgs");
      const gap = () => msgs.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
      await expect(msgs).toContainText("Message 29");
      expect(await msgs.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
      await expect.poll(gap).toBeLessThan(4);
      await expect(page.getByText("Message 29", { exact: true })).toBeInViewport();
      // A poll swap while the reader is at the bottom keeps the newest message in view …
      await page.waitForResponse((r) => r.url().endsWith("/messages"));
      await expect.poll(gap).toBeLessThan(4);
      // … and one that lands after a manual scroll up does not drag them back down.
      await msgs.evaluate((el) => { el.scrollTop = 0; });
      await page.waitForResponse((r) => r.url().endsWith("/messages"));
      expect(await msgs.evaluate((el) => el.scrollTop)).toBeLessThan(4);
    } finally {
      if (channelId) await client.query("DELETE FROM channels WHERE id = $1", [channelId]);
      await client.end();
    }
  });
}

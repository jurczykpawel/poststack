import { test, expect } from "@playwright/test";
import { Client } from "pg";
import { E2E_DATABASE_URL } from "./env";

test("Telegram channel: Publish to panel, composer hint until a target is set", async ({ page }) => {
  const client = new Client({ connectionString: E2E_DATABASE_URL });
  await client.connect();
  let channelId = "";
  try {
    const { rows: [ws] } = await client.query("select workspace_id from brands where key='e2e-brand' limit 1");
    const { rows: [ch] } = await client.query(
      `insert into channels (workspace_id, platform, platform_id, display_name, token_encrypted, webhook_secret, status, connection_mode, brand_key)
       values ($1, 'telegram', 'e2e-tg-bot', 'E2E Telegram bot', 'x', 'wh', 'active', 'manual_token', 'e2e-brand') returning id`, [ws.workspace_id]);
    channelId = ch.id;

    await page.goto(`/channels/${channelId}`);
    const panel = page.locator("#publish-target-panel");
    await expect(panel).toContainText("Not set");
    await panel.getByLabel("Publish to (Telegram @username or chat id)").fill("not a chat");
    await panel.getByRole("button", { name: "Save publish target" }).click();
    await expect(page.locator(".toasts")).toContainText("Enter a channel @username or a numeric chat id");
    expect((await client.query("select publish_target from channels where id=$1", [channelId])).rows[0].publish_target).toBeNull();

    await page.goto("/compose");
    await page.getByRole("button", { name: "Brand", exact: true }).click();
    await page.getByRole("option", { name: "E2E Brand", exact: true }).click();
    await expect(page.getByText("can't publish yet")).toBeVisible();
    await expect(page.locator(".target", { hasText: "Telegram" })).toHaveCount(0);

    await client.query("update channels set publish_target='@acme_news' where id=$1", [channelId]);
    await page.reload();
    await page.getByRole("button", { name: "Brand", exact: true }).click();
    await page.getByRole("option", { name: "E2E Brand", exact: true }).click();
    await expect(page.locator(".target", { hasText: "Telegram" })).toBeVisible();
    await expect(page.getByText("can't publish yet")).toHaveCount(0);
  } finally {
    if (channelId) await client.query("delete from channels where id=$1", [channelId]);
    await client.end();
  }
});

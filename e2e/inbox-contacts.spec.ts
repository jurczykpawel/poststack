import { test, expect } from "@playwright/test";
import { Client } from "pg";
import { E2E_DATABASE_URL } from "./env";
import { gotoOk, setPro, watchConsole } from "./helpers";

test.use({ timezoneId: "Europe/Warsaw" });

for (const width of [1280, 390]) {
  test(`Contacts and Inbox filters stay current at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.clock.setFixedTime(new Date("2026-10-27T12:00:00Z"));
    await setPro(page.request);
    const { errors } = watchConsole(page);
    const client = new Client({ connectionString: E2E_DATABASE_URL });
    await client.connect();
    let channelId: string | undefined;
    let contactId: string | undefined;
    const name = `Filter ${width}%`;
    try {
      const ws = await client.query<{ id: string }>("SELECT id FROM workspaces ORDER BY created_at LIMIT 1");
      const workspaceId = ws.rows[0].id;
      const channel = await client.query<{ id: string }>(
        `INSERT INTO channels (workspace_id, platform, platform_id, display_name, token_encrypted, webhook_secret, status, brand_key)
         VALUES ($1, 'facebook', $2, $2, 'x', 's', 'active', 'e2e-brand') RETURNING id`,
        [workspaceId, `filter-${width}`],
      );
      channelId = channel.rows[0].id;
      const contact = await client.query<{ id: string }>(
        "INSERT INTO contacts (workspace_id, display_name) VALUES ($1, $2) RETURNING id", [workspaceId, name],
      );
      contactId = contact.rows[0].id;
      await client.query(
        "INSERT INTO contact_channels (contact_id, channel_id, platform_sender_id) VALUES ($1, $2, $3)",
        [contactId, channelId, `filter-${width}`],
      );
      const conv = await client.query<{ id: string }>(
        `INSERT INTO conversations (workspace_id, channel_id, contact_id, platform, last_message_at)
         VALUES ($1, $2, $3, 'facebook', now()) RETURNING id`, [workspaceId, channelId, contactId],
      );
      const conversationId = conv.rows[0].id;
      // Warsaw has two messages on Oct 26 despite their different UTC dates.
      for (const [i, at] of ["2026-10-24T10:00:00Z", "2026-10-25T23:30:00Z", "2026-10-26T00:30:00Z", "2026-10-27T10:00:00Z"].entries()) {
        await client.query(
          `INSERT INTO messages (conversation_id, direction, platform_message_id, text, created_at)
           VALUES ($1, 'inbound', $2, 'Dated message', $3)`, [conversationId, `date-${width}-${i}`, at],
        );
      }

      await gotoOk(page, `/contacts?q=${encodeURIComponent(name)}&brand=e2e-brand&channel=${channelId}&platform=facebook`);
      const search = page.locator('input[name="q"]');
      await expect(search).toHaveValue(name);
      for (const [field, value] of [["brand", "e2e-brand"], ["channel", channelId], ["platform", "facebook"]]) {
        await expect(page.locator(`select[name="${field}"]`)).toHaveValue(value);
      }
      await expect(page.locator("#contacts-list tbody tr")).toHaveCount(1);
      await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }), search.press("Enter")]);
      await expect(search).toHaveValue(name);
      await expect(page.locator("#contacts-list tbody tr")).toHaveCount(1);

      await gotoOk(page, "/inbox");
      await page.locator("#conv-filter-form").getByRole("button", { name: "All channels", exact: true }).click();
      await page.getByRole("option", { name: `Facebook · filter-${width}`, exact: true }).click();
      await expect(page.locator(`#conv-filter-form option[value="${channelId}"]`)).toHaveAttribute("selected", "");
      await expect(page.locator("#conv-panel")).not.toHaveClass(/htmx-settling/);
      await page.locator('#conv-filter-form input[name="search"]').fill(name);
      await expect(page.locator('#conv-filter-form input[name="search"]')).toHaveAttribute("value", name);
      const row = page.locator(`.conv-item[hx-get="/inbox/${conversationId}"]`);
      await expect(row).toBeVisible();
      const openThread = async () => {
        const loaded = page.waitForResponse((response) =>
          new URL(response.url()).pathname === `/inbox/${conversationId}` && response.request().method() === "GET",
        );
        await row.click();
        expect((await loaded).ok()).toBe(true);
        await expect(row).not.toHaveClass(/htmx-request/);
        await expect(page.locator("#thread")).not.toHaveClass(/htmx-(settling|swapping)/);
      };
      await expect(page.locator("#conv-panel")).not.toHaveClass(/htmx-settling/);
      await openThread();
      const separators = page.locator("#thread .daysep:visible");
      await expect(separators).toHaveCount(3);
      await expect(separators.nth(0)).toContainText("24");
      await expect(separators.nth(1)).toHaveText("Yesterday");
      await expect(separators.nth(2)).toHaveText("Today");
      await page.screenshot({ path: testInfo.outputPath(`thread-${width}.png`) });
      await expect(page.locator("#thread")).not.toHaveClass(/htmx-settling/);
      await page.locator(".th-actions").getByRole("button", { name: "Done", exact: true }).click();
      await expect(page.getByRole("button", { name: "Reopen", exact: true })).toBeVisible();
      await expect(row).toHaveCount(0);
      await expect(page.locator("#thread")).not.toHaveClass(/htmx-settling/);
      if (width < 600) await page.getByRole("button", { name: "← Back", exact: true }).click();
      await expect(page.locator("#conv-filter-form").getByRole("button", { name: "Done (1)", exact: true })).toBeVisible();
      await expect(page.locator("#conv-panel")).not.toHaveClass(/htmx-settling/);
      await expect(page.locator('#conv-filter-form select[name="channel"]')).toHaveValue(channelId);
      await expect(page.locator('#conv-filter-form input[name="search"]')).toHaveValue(name);
      await page.locator("#conv-filter-form").getByRole("button", { name: "Done (1)", exact: true }).click();
      await expect(row).toBeVisible();
      await expect(page.locator("#conv-panel")).not.toHaveClass(/htmx-settling/);
      await openThread();
      await expect(page.getByRole("button", { name: "Reopen", exact: true })).toBeVisible();
      await expect(page.locator("#thread")).not.toHaveClass(/htmx-settling/);
      await page.getByRole("button", { name: "Reopen", exact: true }).click();
      await expect(page.locator(".th-actions").getByRole("button", { name: "Done", exact: true })).toBeVisible();
      await expect(row).toHaveCount(0);
      await expect(page.locator("#thread")).not.toHaveClass(/htmx-settling/);
      if (width < 600) await page.getByRole("button", { name: "← Back", exact: true }).click();
      await expect(page.locator("#conv-filter-form").getByRole("button", { name: "Done", exact: true })).toBeVisible();
      await expect(page.locator('#conv-filter-form input[name="filter"]')).toHaveValue("done");
      expect(errors).toEqual([]);
    } finally {
      if (channelId) await client.query("DELETE FROM channels WHERE id = $1", [channelId]);
      if (contactId) await client.query("DELETE FROM contacts WHERE id = $1", [contactId]);
      await client.end();
    }
  });
}

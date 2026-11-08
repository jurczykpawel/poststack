import { test, expect } from "@playwright/test";
import { Client } from "pg";
import { E2E_DATABASE_URL } from "./env";
import { gotoOk, setPro } from "./helpers";

for (const width of [390, 1440]) {
  test(`Inbox Older preserves order, filters and navigation at ${width}px`, async ({ page }, info) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await setPro(page.request);
    const db = new Client({ connectionString: E2E_DATABASE_URL });
    await db.connect();
    const channels: string[] = [];
    const contacts: string[] = [];
    const seed: { id: string; channel: string; unread: boolean; needs: boolean; open: boolean }[] = [];
    try {
      const ws = (await db.query("SELECT id FROM workspaces ORDER BY created_at LIMIT 1")).rows[0].id;
      for (const platform of ["facebook", "instagram"]) {
        channels.push((await db.query(`INSERT INTO channels (workspace_id,platform,platform_id,display_name,token_encrypted,webhook_secret,status)
          VALUES ($1,$2,$3,$3,'x','s','active') RETURNING id`, [ws, platform, `older-${width}-${platform}`])).rows[0].id);
      }
      for (let i = 0; i < 120; i++) {
        const contact = (await db.query("INSERT INTO contacts (workspace_id,display_name) VALUES ($1,$2) RETURNING id", [ws, `Older ${width} ${i}`])).rows[0].id;
        contacts.push(contact);
        const channel = channels[i < 90 ? 0 : 1];
        const unread = i % 5 !== 0;
        const needs = i % 4 !== 0;
        const open = i < 110;
        const id = `61000000-0000-4000-8000-${String(120 - i).padStart(12, "0")}`;
        // Groups of ten share a timestamp, including both sides of the page boundary.
        await db.query(`INSERT INTO conversations (id,workspace_id,channel_id,contact_id,platform,status,unread_count,needs_manual_reply,last_message_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, ws, channel, contact, i < 90 ? "facebook" : "instagram", open ? "open" : "closed", unread ? 1 : 0, needs, new Date(Date.UTC(2026, 0, 1) - Math.floor((i + 3) / 10) * 60_000)]);
        seed.push({ id, channel, unread, needs, open });
      }
      const rows = page.locator(".conv-item");
      const ids = () => rows.evaluateAll((els) => els.map((el) => el.getAttribute("data-row")));
      for (const filter of ["open", "unread", "needs_reply", "channel"]) {
        const expected = seed.filter((r) => r.open && (filter !== "unread" || r.unread) && (filter !== "needs_reply" || r.needs) && (filter !== "channel" || r.channel === channels[0])).map((r) => r.id);
        const query = new URLSearchParams({ search: `Older ${width}`, filter: filter === "channel" ? "open" : filter });
        if (filter === "channel") query.set("channel", channels[0]);
        await gotoOk(page, `/inbox?${query}`);
        await expect(rows).toHaveCount(50);
        expect(await ids()).toEqual(expected.slice(0, 50));
        let loaded = 50;
        while (loaded < expected.length) {
          await page.getByRole("button", { name: "Older", exact: true }).click();
          loaded = Math.min(loaded + 50, expected.length);
          await expect(rows).toHaveCount(loaded);
          expect(await ids()).toEqual(expected.slice(0, loaded));
        }
        await expect(page.getByRole("button", { name: "Older", exact: true })).toHaveCount(0);
        const listUrl = page.url();
        await Promise.all([
          page.waitForResponse((r) => new URL(r.url()).pathname === "/inbox/list"),
          page.evaluate(() => document.body.dispatchEvent(new Event("sse:message", { bubbles: true }))),
        ]);
        await expect(page.locator("#conv-panel")).not.toHaveClass(/htmx-(request|settling|swapping)/);
        await expect(rows).toHaveCount(expected.length);
        expect(await ids()).toEqual(expected);
        await expect(page).toHaveURL(listUrl);
        await page.reload();
        await expect(rows).toHaveCount(expected.length);
        expect(await ids()).toEqual(expected);
        const secondTab = await page.context().newPage();
        try {
          await gotoOk(secondTab, listUrl);
          await expect(secondTab.locator(".conv-item")).toHaveCount(expected.length);
          expect(await secondTab.locator(".conv-item").evaluateAll((els) => els.map((el) => el.getAttribute("data-row")))).toEqual(expected);
        } finally {
          await secondTab.close();
        }
        await page.screenshot({ path: info.outputPath(`${filter}-restored.png`), animations: "disabled" });
        if (filter === "unread") continue; // Opening a thread marks it read and removes it from this view.
        const row = page.locator(`[data-row="${expected[55]}"]`);
        await row.focus();
        await row.press("Enter");
        await expect(page.locator("#thread .thread-head")).toBeVisible();
        expect(new URL(page.url()).searchParams.get("search")).toBe(`Older ${width}`);
        if (width === 1440) {
          const openUrl = page.url();
          await Promise.all([
            page.waitForResponse((r) => new URL(r.url()).pathname === `/inbox/${expected[55]}`),
            row.click(),
          ]);
          await expect(row).not.toHaveClass(/htmx-request/);
          await expect(page).toHaveURL(openUrl);
        }
        await page.reload();
        await expect(page.locator("#thread .thread-head")).toBeVisible();
        const restored = page.waitForResponse((r) => new URL(r.url()).pathname === "/inbox/list" && r.request().headers()["x-inbox-refresh"] === "true");
        if (width === 390) await page.locator(".thread-back").click();
        else await page.goBack();
        await restored;
        await expect(page.locator("#conv-panel")).not.toHaveClass(/htmx-(request|settling|swapping)/);
        await expect(page).toHaveURL(listUrl);
        await expect(rows).toHaveCount(expected.length);
        expect(await ids()).toEqual(expected);
        await expect(row).toBeFocused();
        await expect(row).toBeInViewport();
        await page.screenshot({ path: info.outputPath(`${filter}.png`), animations: "disabled" });
      }
      // A filter selected interactively also becomes a refreshable address.
      await page.getByRole("button", { name: "Needs reply", exact: true }).click();
      await expect(page).toHaveURL(/filter=needs_reply/);
      await page.reload();
      await expect(rows).toHaveCount(50);
      await page.goBack();
      await expect(page).toHaveURL(/filter=open/);
    } finally {
      await db.query("DELETE FROM channels WHERE id=ANY($1::uuid[])", [channels]);
      await db.query("DELETE FROM contacts WHERE id=ANY($1::uuid[])", [contacts]);
      await db.end();
    }
  });
}

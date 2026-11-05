import { test, expect } from "@playwright/test";
import { Client } from "pg";
import { E2E_DATABASE_URL } from "./env";
import { gotoOk, setPro } from "./helpers";

test.beforeEach(async ({ page }) => { await page.emulateMedia({ reducedMotion: "reduce" }); });

for (const timezoneId of ["Europe/Warsaw", "Pacific/Auckland"]) {
  test.describe(timezoneId, () => {
    test.use({ timezoneId, viewport: { width: 390, height: 844 } });
    test("thread URL survives refresh and Back closes it; clocks follow local days", async ({ page }, info) => {
      await setPro(page.request);
      const db = new Client({ connectionString: E2E_DATABASE_URL });
      await db.connect();
      let channel: string | undefined;
      let contact: string | undefined;
      try {
        const ws = (await db.query("SELECT id FROM workspaces ORDER BY created_at LIMIT 1")).rows[0].id;
        channel = (await db.query("INSERT INTO channels (workspace_id,platform,platform_id,token_encrypted,webhook_secret,status) VALUES ($1,'facebook',$2,'x','s','active') RETURNING id", [ws, timezoneId])).rows[0].id;
        contact = (await db.query("INSERT INTO contacts (workspace_id,display_name) VALUES ($1,'Timezone thread') RETURNING id", [ws])).rows[0].id;
        const conv = (await db.query("INSERT INTO conversations (workspace_id,channel_id,contact_id,platform,last_message_at) VALUES ($1,$2,$3,'facebook',now()) RETURNING id", [ws, channel, contact])).rows[0].id;
        await db.query("INSERT INTO messages (conversation_id,direction,text,created_at) VALUES ($1,'inbound','Local clock','2026-10-26T18:00:00Z')", [conv]);
        const second = (await db.query("INSERT INTO conversations (workspace_id,channel_id,contact_id,platform,thread_ref,last_message_at) VALUES ($1,$2,$3,'facebook','second',now()) RETURNING id", [ws, channel, contact])).rows[0].id;
        await db.query("INSERT INTO messages (conversation_id,direction,text,created_at) VALUES ($1,'inbound','Second thread','2026-10-26T18:00:00Z')", [second]);
        await gotoOk(page, "/inbox");
        const row = page.locator(`.conv-item[hx-get="/inbox/${conv}"]`);
        await row.focus();
        await row.press("Enter");
        await expect(page.locator(".thread-back")).toBeVisible();
        await page.locator(".thread-back").click();
        await expect(page).toHaveURL(/\/inbox$/);
        await expect(row).toBeFocused();
        await row.press("Enter");
        await expect(page).toHaveURL(new RegExp(`open=${conv}`));
        await expect(page.locator("#thread .msg-meta")).toContainText(timezoneId === "Europe/Warsaw" ? "19:00" : "07:00");
        await expect(page.locator("#thread .daysep:visible")).toContainText(timezoneId === "Europe/Warsaw" ? "26" : "27");
        await page.reload();
        await expect(page.locator("#thread")).toContainText("Local clock");
        for (const theme of ["dark", "light"]) {
          await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
          await page.screenshot({ animations: "disabled", path: info.outputPath(`${theme}.png`) });
        }
        // Navigate after a reload too: an old deep-link loader must not reopen its thread.
        await page.setViewportSize({ width: 1280, height: 844 });
        await page.locator(`.conv-item[hx-get="/inbox/${second}"]`).click();
        await expect(page.locator("#thread")).toContainText("Second thread");
        await page.goBack();
        await expect(page.locator("#thread")).toContainText("Local clock");
        await expect(page.locator("#thread")).not.toContainText("Second thread");
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goBack();
        await expect(page).toHaveURL(/\/inbox$/);
        await expect(page.locator("#conv-panel")).toBeVisible();
        await expect(page.locator("#thread .thread-head")).toHaveCount(0);
        await page.goForward();
        await expect(page.locator("#thread")).toContainText("Local clock");
      } finally {
        if (channel) await db.query("DELETE FROM channels WHERE id=$1", [channel]);
        if (contact) await db.query("DELETE FROM contacts WHERE id=$1", [contact]);
        await db.end();
      }
    });
  });
}

test("fresh workspace without brands has a direct setup action", async ({ page }, info) => {
  await setPro(page.request);
  const db = new Client({ connectionString: E2E_DATABASE_URL });
  await db.connect();
  const saved = (await db.query("SELECT * FROM brands")).rows;
  const assignments = (await db.query("SELECT id,brand_key FROM channels")).rows;
  try {
    await db.query("UPDATE channels SET brand_key=NULL");
    await db.query("DELETE FROM brands");
    expect((await db.query("SELECT count(*)::int AS n FROM brands")).rows[0].n).toBe(0);
    expect((await db.query("SELECT count(*)::int AS n FROM channels WHERE status='active' AND brand_key IS NULL")).rows[0].n).toBeGreaterThan(0);
    await gotoOk(page, "/compose");
    await page.screenshot({ animations: "disabled", path: info.outputPath("no-brands.png") });
    await expect(page.getByRole("link", { name: "Set up brand & channels" })).toBeVisible();
    await page.getByRole("link", { name: "Set up brand & channels" }).click();
    const dialog = page.getByRole("dialog", { name: "New brand", exact: true });
    await expect(dialog).toBeVisible();
    await dialog.locator('input[name="key"]').fill("g46-setup");
    await dialog.locator('input[name="name"]').fill("My channels");
    await dialog.getByRole("button", { name: "Create brand", exact: true }).click();
    await expect(page.locator("#brand-g46-setup")).toBeVisible();
    const slot = page.locator("#slot-g46-setup-facebook");
    await slot.locator("button.ps-trigger").click();
    await slot.getByRole("option", { name: "E2E FB Page", exact: true }).click();
    await expect.poll(async () => (await db.query("SELECT brand_key FROM channels WHERE platform_id='fb_e2e_1'")).rows[0].brand_key).toBe("g46-setup");
    await page.getByRole("link", { name: "Back to Compose", exact: true }).click();
    await page.getByRole("button", { name: "Brand", exact: true }).click();
    await page.getByRole("option", { name: "My channels", exact: true }).click();
    await page.getByRole("button", { name: "Content type", exact: true }).click();
    await page.getByRole("option", { name: "Image", exact: true }).click();
    await page.getByLabel("Title (internal)").fill("First post without prior brands");
    await page.getByLabel("Media URL", { exact: true }).fill("https://cdn.example.test/compose.png");
    await page.locator(".compose-pubbar button[type=submit]").click();
    await expect(page).toHaveURL(/\/content\/[0-9a-f-]+$/);
    for (const theme of ["dark", "light"]) {
      await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
      await page.screenshot({ animations: "disabled", path: info.outputPath(`first-post-${theme}.png`) });
    }
  } finally {
    await db.query("DELETE FROM content WHERE title='First post without prior brands'");
    await db.query("UPDATE channels SET brand_key=NULL WHERE brand_key='g46-setup'");
    await db.query("DELETE FROM brands WHERE key='g46-setup'");
    for (const b of saved) await db.query("INSERT INTO brands SELECT * FROM json_populate_record(NULL::brands,$1::json)", [JSON.stringify(b)]);
    for (const ch of assignments) await db.query("UPDATE channels SET brand_key=$1 WHERE id=$2", [ch.brand_key, ch.id]);
    await db.end();
  }
});

test("channel connection offers one token entry point", async ({ page }) => {
  await gotoOk(page, "/channels?connect=1");
  const sheet = page.locator("#connect-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText(/connect with a token/i)).toHaveCount(1);
});

test("Compose opens an empty brand's channel assignments on a phone", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setPro(page.request);
  const db = new Client({ connectionString: E2E_DATABASE_URL });
  await db.connect();
  const assignments = (await db.query("SELECT id,brand_key FROM channels")).rows;
  try {
    await db.query("UPDATE channels SET brand_key=NULL");
    await gotoOk(page, "/compose");
    await page.getByRole("button", { name: "Brand", exact: true }).click();
    await page.getByRole("option", { name: "E2E Brand", exact: true }).click();
    const action = page.getByRole("link", { name: "Assign channels", exact: true });
    await expect(action).toBeVisible();
    for (const theme of ["dark", "light"]) {
      await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
      await page.screenshot({ animations: "disabled", path: info.outputPath(`empty-brand-${theme}.png`) });
    }
    await action.click();
    await expect(page.locator("#brand-e2e-brand")).toHaveClass(/open/);
    await expect(page.locator("#slot-e2e-brand-facebook button.ps-trigger")).toBeVisible();
  } finally {
    for (const ch of assignments) await db.query("UPDATE channels SET brand_key=$1 WHERE id=$2", [ch.brand_key, ch.id]);
    await db.end();
  }
});

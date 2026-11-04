import { test, expect } from "@playwright/test";
import { Client } from "pg";
import { E2E_DATABASE_URL } from "./env";
import { setPro } from "./helpers";

test("Compose preserves the submitted draft after an invalid media URL", async ({ page }, testInfo) => {
  await setPro(page.request);
  await page.goto("/compose");
  await page.evaluate(() => {
    const form = document.createElement("form");
    form.method = "post"; form.action = "/compose";
    const input = document.createElement("input"); input.name = "payload";
    input.value = JSON.stringify({ brand: "e2e-brand", title: "Retained title", contentType: "image", mediaUrl: "ftp://invalid.test/a.png", baseDescription: "Retained description", posts: [{ platform: "facebook", description: "Retained override" }] });
    form.append(input); document.body.append(form); form.submit();
  });
  await expect(page.locator('input[x-model="title"]')).toHaveValue("Retained title");
  await expect(page.locator('input[x-model="mediaUrl"]')).toHaveValue("ftp://invalid.test/a.png");
  await expect(page.locator('textarea[x-model="baseDescription"]')).toHaveValue("Retained description");
  await expect(page.locator('input[x-model="mediaUrl"]')).toHaveAttribute("aria-invalid", "true");
  for (const width of [390, 1440]) for (const theme of ["dark", "light"]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(t => document.documentElement.setAttribute("data-theme", t), theme);
    await page.screenshot({ path: testInfo.outputPath(`compose-error-${width}-${theme}.png`) });
  }
});

test("long rule values keep actions within the table viewport", async ({ page }, testInfo) => {
  await setPro(page.request);
  const db = new Client({ connectionString: E2E_DATABASE_URL }); await db.connect();
  const { rows: [ws] } = await db.query("SELECT workspace_id AS id FROM channels WHERE platform='facebook' LIMIT 1");
  const { rows: [r] } = await db.query("INSERT INTO auto_reply_rules (workspace_id,name,trigger_type,trigger_config,response_type,response_config) VALUES ($1,$2,'keyword',$3,'text',$4) RETURNING id", [ws.id, "R".repeat(100), JSON.stringify({ keywords: [{ value: "K".repeat(500), match_type: "contains" }] }), JSON.stringify({ text: "T".repeat(2000) })]);
  try {
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 }); await page.goto("/rules");
      const edit = page.locator(`button[hx-get='/rules/${r.id}/edit']`);
      await expect(edit).toBeVisible();
      expect(await edit.evaluate(el => { const a = el.getBoundingClientRect(); const b = el.closest('.table-wrap')!.getBoundingClientRect(); return a.right <= b.right && a.left >= b.left; })).toBe(true);
      for (const theme of ["dark", "light"]) {
        await page.evaluate(t => document.documentElement.setAttribute("data-theme", t), theme);
        await page.screenshot({ path: testInfo.outputPath(`rules-${width}-${theme}.png`) });
      }
    }
  } finally { await db.query("DELETE FROM auto_reply_rules WHERE id=$1", [r.id]); await db.end(); }
});

test("active mobile New post has a visible plus", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto("/compose");
  for (const theme of ["dark", "light"]) {
    await page.evaluate(t => document.documentElement.setAttribute("data-theme", t), theme);
    const ico = page.locator('.mobile-nav a.mnav-new .ico');
    expect(await ico.evaluate(el => { const s = getComputedStyle(el); return s.color !== s.backgroundColor; })).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`compose-390-${theme}.png`) });
  }
});

test("approval edits validate whitespace and move keyboard focus", async ({ page }, testInfo) => {
  await setPro(page.request);
  const db = new Client({ connectionString: E2E_DATABASE_URL }); await db.connect();
  const { rows: [ch] } = await db.query("SELECT id,workspace_id FROM channels WHERE platform='facebook' LIMIT 1");
  const { rows: [contact] } = await db.query("INSERT INTO contacts (workspace_id,display_name) VALUES ($1,'G48 approval') RETURNING id", [ch.workspace_id]);
  await db.query("INSERT INTO contact_channels (contact_id,channel_id,platform_sender_id) VALUES ($1,$2,'g48-review')", [contact.id, ch.id]);
  const { rows: [conv] } = await db.query("INSERT INTO conversations (workspace_id,channel_id,contact_id,platform,last_message_at,last_inbound_at) VALUES ($1,$2,$3,'facebook',now(),now()) RETURNING *", [ch.workspace_id,ch.id,contact.id]);
  conv.platform_sender_id = "g48-review";
  const { rows: [a] } = await db.query("INSERT INTO pending_approvals (workspace_id,channel_id,contact_id,conversation_id,recipient_platform_id,source,proposed_content) VALUES ($1,$2,$3,$4,$5,'ai_auto',$6) RETURNING id", [conv.workspace_id, conv.channel_id, conv.contact_id, conv.id, conv.platform_sender_id, JSON.stringify({ content: { text: "Review this reply" } })]);
  try {
    await page.goto("/approvals");
    const card = page.locator('.appr', { hasText: "Review this reply" });
    await card.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(card.getByRole("textbox", { name: "Reply text" })).toBeFocused();
    await card.getByRole("button", { name: "Cancel" }).click();
    await expect(card.getByRole("button", { name: "Edit", exact: true })).toBeFocused();
    await card.getByRole("button", { name: "Edit", exact: true }).click();
    await card.getByRole("textbox", { name: "Reply text" }).fill("   ");
    await card.getByRole("button", { name: "Save", exact: true }).click();
    await expect(card.getByRole("alert")).toContainText("Reply text is required");
    await expect(card.getByRole("textbox", { name: "Reply text" })).toBeVisible();
    for (const width of [390, 1440]) for (const theme of ["dark", "light"]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(t => document.documentElement.setAttribute("data-theme", t), theme);
      await page.screenshot({ path: testInfo.outputPath(`approval-validation-${width}-${theme}.png`) });
    }
  } finally { await db.query("DELETE FROM pending_approvals WHERE id=$1", [a.id]); await db.query("DELETE FROM contacts WHERE id=$1", [contact.id]); await db.end(); }
});

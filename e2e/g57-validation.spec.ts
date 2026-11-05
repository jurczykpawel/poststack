import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { Client } from "pg";
import { E2E_DATABASE_URL } from "./env";
import { setPro } from "./helpers";

async function screenshots(page: Page, info: TestInfo, name: string) {
  for (const width of [390, 1440]) for (const theme of ["dark", "light"]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(t => document.documentElement.setAttribute("data-theme", t), theme);
    await page.screenshot({ path: info.outputPath(`${name}-${width}-${theme}.png`) });
    const layout = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, viewport: innerWidth }));
    await info.attach(`${name}-${width}-${theme}-layout`, { body: JSON.stringify(layout), contentType: "application/json" });
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.viewport);
  }
}

test("brand accent errors preserve the editor and allow correction", async ({ page }, info) => {
  await setPro(page.request);
  const created = await page.request.post("/api/v1/brands", { data: { key: "g57-brand", name: "G57 Brand", accent: "#123456" } });
  expect(created.status()).toBe(201);
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  try {
    await page.goto("/brands");
    const row = page.locator("#brand-g57-brand");
    await row.getByRole("button", { name: "Edit", exact: true }).click();
    const dialog = row.locator("dialog");
    await dialog.locator('[name="name"]').fill("Unsaved G57");
    for (const accent of ["red", "#f00;background-image:url(https://example.invalid/x.png)", "red"]) {
      await dialog.getByRole("textbox", { name: "Accent colour hex" }).fill(accent);
      await dialog.getByRole("button", { name: "Save changes" }).click();
      await expect(dialog.getByRole("alert")).toContainText("Accent colour must be a hex colour");
      await expect(dialog.locator('[name="name"]')).toHaveValue("Unsaved G57");
      await expect(dialog.getByRole("textbox", { name: "Accent colour hex" })).toHaveValue(accent);
      const listed = await page.request.get("/api/v1/brands");
      expect(listed.status()).toBe(200);
      expect((await listed.json()).data.find((b: { key: string }) => b.key === "g57-brand").name).toBe("G57 Brand");
    }
    await screenshots(page, info, "brand-error");
    await dialog.getByRole("textbox", { name: "Accent colour hex" }).fill("#ff0000");
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(row).toContainText("Unsaved G57");
    const saved = (await (await page.request.get("/api/v1/brands")).json()).data.find((b: { key: string }) => b.key === "g57-brand");
    expect(saved).toMatchObject({ name: "Unsaved G57", accent: "#ff0000" });
    expect(errors).toEqual([]);
  } finally { await page.request.delete("/api/v1/brands/g57-brand"); }
});

test("draft validation preserves thread and long approvals fit their cards", async ({ page }, info) => {
  await setPro(page.request);
  const db = new Client({ connectionString: E2E_DATABASE_URL }); await db.connect();
  const { rows: [ch] } = await db.query("SELECT id,workspace_id FROM channels WHERE platform='facebook' LIMIT 1");
  const { rows: [contact] } = await db.query("INSERT INTO contacts (workspace_id,display_name) VALUES ($1,'G57 Draft') RETURNING id", [ch.workspace_id]);
  await db.query("INSERT INTO contact_channels (contact_id,channel_id,platform_sender_id) VALUES ($1,$2,'g57-review')", [contact.id,ch.id]);
  const { rows: [conv] } = await db.query("INSERT INTO conversations (workspace_id,channel_id,contact_id,platform,last_message_at,last_inbound_at) VALUES ($1,$2,$3,'facebook',now(),now()) RETURNING id", [ch.workspace_id,ch.id,contact.id]);
  await db.query("INSERT INTO messages (conversation_id,direction,text,platform_message_id) VALUES ($1,'inbound','G57 retained history','g57-message')", [conv.id]);
  const { rows: [draft] } = await db.query("INSERT INTO pending_approvals (workspace_id,channel_id,contact_id,conversation_id,recipient_platform_id,source,proposed_content) VALUES ($1,$2,$3,$4,'g57-review','ai_auto',$5) RETURNING id", [ch.workspace_id,ch.id,contact.id,conv.id,JSON.stringify({ content: { text: "G57 original draft" } })]);
  try {
    await page.goto("/approvals");
    const card = page.locator(".appr", { hasText: "G57 original draft" });
    await card.getByRole("button", { name: "Edit", exact: true }).click();
    await card.getByRole("textbox", { name: "Reply text" }).fill("G57" + "x".repeat(1997));
    await card.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator(".appr-reply-text", { hasText: "G57xxx" })).toBeVisible();
    await page.reload();
    const reply = page.locator(".appr-reply-text", { hasText: "G57xxx" });
    await expect(reply).toBeVisible();
    await screenshots(page, info, "long-approval");
    expect(await reply.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await db.query("UPDATE pending_approvals SET proposed_content=$2 WHERE id=$1", [draft.id, JSON.stringify({ content: { text: "G57 original draft" } })]);
    await page.goto(`/inbox?open=${conv.id}`);
    const bubble = page.locator(`[data-approval-id='${draft.id}']`);
    await bubble.getByRole("button", { name: "Edit", exact: true }).click();
    await bubble.locator("textarea").fill("before\u0000after");
    await bubble.getByRole("button", { name: "Save", exact: true }).click();
    await expect(bubble.getByRole("alert")).toContainText("Text must not contain NUL");
    await expect(page.locator("#thread")).toContainText("G57 retained history");
    await expect(bubble.locator("textarea")).toHaveValue("before\u0000after");
    await screenshots(page, info, "draft-error");
    expect((await db.query("SELECT proposed_content FROM pending_approvals WHERE id=$1", [draft.id])).rows[0].proposed_content.content.text).toBe("G57 original draft");
    await bubble.locator("textarea").fill("G57 corrected draft");
    await bubble.getByRole("button", { name: "Save", exact: true }).click();
    await expect(bubble.locator(".draft-text")).toHaveText("G57 corrected draft");
    await page.reload();
    await expect(page.locator("#thread")).toContainText("G57 corrected draft");
    await expect(page.locator("#thread")).toContainText("G57 retained history");
  } finally {
    await db.query("DELETE FROM pending_approvals WHERE id=$1", [draft.id]);
    await db.query("DELETE FROM contacts WHERE id=$1", [contact.id]); await db.end();
  }
});

test("contact addresses survive repeated htmx panel swaps", async ({ page }, info) => {
  await setPro(page.request);
  const db = new Client({ connectionString: E2E_DATABASE_URL }); await db.connect();
  const { rows: [ch] } = await db.query("SELECT workspace_id FROM channels WHERE platform='facebook' LIMIT 1");
  const { rows } = await db.query("INSERT INTO contacts (workspace_id,display_name,email) VALUES ($1,'G57 Anna','g57-anna@example.invalid'),($1,'G57 Ben','g57-ben@example.invalid') RETURNING id,email", [ch.workspace_id]);
  let swaps = 0;
  try {
    await page.route("**/contacts?**", async route => {
      if (route.request().headers()["hx-request"] === "true") swaps++;
      const response = await route.fetch();
      const body = await response.text();
      // Model the proxy's documented no-transform contract for swapped HTML.
      await route.fulfill({ response, body: response.headers()["cache-control"]?.includes("no-transform") ? body : body.replace(/g57-[a-z]+@example.invalid/g, "[email protected]") });
    });
    await page.goto(`/contacts?q=G57&open=${rows[0].id}`);
    for (const row of [rows[1], rows[0], rows[1], rows[0]]) {
      await page.waitForFunction(() => [...document.querySelectorAll('#data-list a[href]')].every(el => el.closest("[hx-boost='false']") || 'htmx-internal-data' in el));
      await page.locator(`[data-row='${row.id}'] a`).first().click();
      await expect(page.locator(".dl-detail")).toContainText(row.email);
      await expect(page.locator(`[data-row='${row.id}']`)).toContainText(row.email);
    }
    expect(swaps).toBeGreaterThanOrEqual(4);
    await screenshots(page, info, "contact-email");
  } finally { await db.query("DELETE FROM contacts WHERE id=ANY($1::uuid[])", [rows.map(r => r.id)]); await db.end(); }
});

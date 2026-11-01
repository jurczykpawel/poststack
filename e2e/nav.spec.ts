import { test, expect } from "@playwright/test";
import { Client } from "pg";
import { setPro, gotoOk } from "./helpers";
import { E2E_DATABASE_URL } from "./env";

// Seeds 2 unread conversations, 1 pending approval and 1 channel needing re-auth on top of whatever earlier
// specs left behind; returns the expected badge values (baseline + seeded) and the undo.
async function seedCounters(): Promise<{ want: Record<"inbox" | "approvals" | "channels", string>; undo: () => Promise<void> }> {
  const db = new Client({ connectionString: E2E_DATABASE_URL });
  await db.connect();
  const { rows: [ch] } = await db.query<{ id: string; workspace_id: string }>("SELECT id, workspace_id FROM channels WHERE platform = 'facebook' LIMIT 1");
  const { rows: [base] } = await db.query<Record<"inbox" | "approvals" | "channels", string>>(
    `SELECT (SELECT count(*) FROM conversations WHERE workspace_id = $1 AND status = 'open' AND unread_count > 0) AS inbox,
            (SELECT count(*) FROM pending_approvals WHERE workspace_id = $1 AND status = 'pending') AS approvals,
            (SELECT count(*) FROM channels WHERE workspace_id = $1 AND status = 'needs_reauth') AS channels`, [ch!.workspace_id]);
  await db.query("UPDATE channels SET status = 'needs_reauth' WHERE id = $1", [ch!.id]);
  const { rows: contacts } = await db.query<{ id: string }>("INSERT INTO contacts (workspace_id, display_name) VALUES ($1, 'Nav seed A'), ($1, 'Nav seed B') RETURNING id", [ch!.workspace_id]);
  const { rows: convs } = await db.query<{ id: string; contact_id: string }>(
    "INSERT INTO conversations (workspace_id, channel_id, contact_id, platform, status, unread_count) SELECT $1, $2, id, 'facebook', 'open', 3 FROM unnest($3::uuid[]) AS id RETURNING id, contact_id",
    [ch!.workspace_id, ch!.id, contacts.map((c) => c.id)]);
  await db.query("INSERT INTO pending_approvals (workspace_id, conversation_id, contact_id, channel_id, recipient_platform_id, proposed_content) VALUES ($1, $2, $3, $4, 'r1', '\"Thanks!\"'::jsonb)",
    [ch!.workspace_id, convs[0]!.id, convs[0]!.contact_id, ch!.id]);
  const want = { inbox: String(Number(base!.inbox) + 2), approvals: String(Number(base!.approvals) + 1), channels: String(Number(base!.channels) + 1) };
  return { want, undo: async () => {
    await db.query("DELETE FROM pending_approvals WHERE id IN (SELECT id FROM pending_approvals WHERE conversation_id = $1)", [convs[0]!.id]);
    await db.query("DELETE FROM conversations WHERE id = ANY($1::uuid[])", [convs.map((c) => c.id)]);
    await db.query("DELETE FROM contacts WHERE id = ANY($1::uuid[])", [contacts.map((c) => c.id)]);
    await db.query("UPDATE channels SET status = 'active' WHERE id = $1", [ch!.id]);
    await db.end();
  } };
}

test("desktop menu: grouped sidebar, New post button, live counters", async ({ page }, testInfo) => {
  const { want, undo } = await seedCounters();
  await setPro(page.request);
  await page.setViewportSize({ width: 1440, height: 900 });
  const counts = page.waitForResponse((r) => r.url().endsWith("/nav/counts") && r.status() === 200);
  await gotoOk(page, "/queue");
  await counts;
  await expect(page.locator("#nav-n-inbox")).toHaveText(want.inbox);
  await expect(page.locator("#nav-n-approvals")).toHaveText(want.approvals);
  await expect(page.locator("#nav-n-channels")).toHaveText(want.channels);
  await expect(page.locator("#nav-n-channels")).toHaveClass(/bad/);
  const heads = await page.locator(".sidebar .nav-sec").allTextContents();
  expect(heads).toEqual(["Publishing", "Conversations", "Automation", "Setup"]);
  await expect(page.locator(".sidebar a.nav-item[aria-current='page']")).toHaveText(/Queue/);
  for (const theme of ["dark", "light"]) {
    await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
    await page.screenshot({ path: testInfo.outputPath(`menu-desktop-${theme}.png`) });
  }
  await page.locator(".sidebar a.side-new").click();
  await expect(page).toHaveURL(/\/compose$/);
  await undo();
});

test("phone bar: Overview, Queue, New post, Inbox + More sheet reaches everything else", async ({ page }, testInfo) => {
  const { want, undo } = await seedCounters();
  await setPro(page.request);
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoOk(page, "/overview");
  await expect(page.locator("#mnav-n-inbox")).toHaveText(want.inbox);
  const bar = page.locator(".mobile-nav");
  expect(await bar.locator(":scope > a").evaluateAll((as) => as.map((a) => a.getAttribute("href")))).toEqual(["/overview", "/queue", "/compose", "/inbox"]);
  await expect(page.locator("#mnav-more")).toBeHidden();
  await bar.getByRole("button", { name: "More" }).click();
  await expect(page.locator("#mnav-more a[href='/channels']")).toBeVisible();
  for (const theme of ["dark", "light"]) {
    await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
    await page.screenshot({ path: testInfo.outputPath(`menu-phone-${theme}.png`) });
  }
  await page.keyboard.press("Escape");
  await expect(page.locator("#mnav-more")).toBeHidden();
  await undo();
});

import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { E2E_DATABASE_URL, serverEnv } from "./env";
import { setPro } from "./helpers";

const video = readFileSync("e2e/fixtures/tiktok-preview.mp4");

function token(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(serverEnv().ENCRYPTION_KEY).digest(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify({ access_token: value })), cipher.final()]);
  return [iv.toString("hex"), cipher.getAuthTag().toString("hex"), encrypted.toString("hex")].join(":");
}
async function creatorToken(value: string) {
  const client = new Client({ connectionString: E2E_DATABASE_URL });
  await client.connect();
  try { await client.query("UPDATE channels SET token_encrypted=$1 WHERE platform_id='tt_e2e_1'", [token(value)]); }
  finally { await client.end(); }
}
async function openComposer(page: Page) {
  await page.goto("/compose");
  await page.getByRole("button", { name: "Brand", exact: true }).click();
  await page.getByRole("option", { name: "E2E Brand", exact: true }).click();
  await expect(page.getByRole("region", { name: "TikTok publishing" })).toBeVisible();
  // Choose only TikTok, preserving the account resolved from the brand.
  await page.locator(".target").filter({ hasText: "Facebook" }).click();
  await page.locator(".target").filter({ hasText: "Instagram" }).click();
  await page.getByLabel("Title (internal)").fill("TikTok browser test");
  await page.getByLabel("Media URL", { exact: true }).fill("https://cdn.example.test/tt3.mp4");
  await page.getByLabel("TikTok delivery").selectOption("direct");
  await page.getByLabel("TikTok caption", { exact: true }).fill("Reviewed TikTok caption");
}

test.beforeEach(async ({ page }) => {
  await page.route("https://cdn.example.test/**", (route) => route.fulfill({ status: 200, contentType: "video/mp4", body: video }));
});

test.beforeAll(async ({ request }) => {
  await setPro(request);
  const client = new Client({ connectionString: E2E_DATABASE_URL });
  await client.connect();
  try {
    await client.query(`INSERT INTO media (workspace_id, checksum, storage_key, url, kind, mime, size, duration_sec, width, height, status)
      SELECT id, $1, 'tt3.mp4', 'https://cdn.example.test/tt3.mp4', 'video', 'video/mp4', $2, 1, 160, 284, 'ready' FROM workspaces LIMIT 1 ON CONFLICT (workspace_id, checksum) DO NOTHING`,
      [createHash("sha256").update(video).digest("hex"), video.length]);
  } finally { await client.end(); }
});

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test(`TikTok choices, preview and scheduled consent at ${viewport.width}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await creatorToken("available");
    await openComposer(page);
    const panel = page.getByRole("region", { name: "TikTok publishing" });
    await expect(panel.getByText("TT3 Creator", { exact: true })).toBeVisible();
    const privacy = page.getByLabel("TikTok privacy");
    await expect(privacy).toHaveValue("");
    for (const interaction of ["Comment", "Duet", "Stitch"]) await expect(panel.getByLabel(`Allow ${interaction}`, { exact: true })).not.toBeChecked();
    await expect(panel.getByLabel("Allow Comment", { exact: true })).toBeDisabled();
    await expect(panel.getByLabel("Allow Stitch", { exact: true })).toBeDisabled();
    await expect(panel.getByLabel("Allow Duet", { exact: true })).toBeEnabled();
    await expect(panel.getByLabel("Allow Comment", { exact: true })).toHaveAttribute("title", /TikTok account settings/);
    await panel.getByLabel("Allow Duet", { exact: true }).check();
    await expect(panel.getByLabel("Commercial Content Disclosure", { exact: true })).not.toBeChecked();
    await panel.getByLabel("Commercial Content Disclosure", { exact: true }).check();
    await page.getByRole("button", { name: "Schedule", exact: true }).click();
    const schedule = page.locator('input[type="datetime-local"]');
    await schedule.fill("2030-01-15T14:30");
    const submit = page.locator('button[type="submit"]');
    await expect(submit).toBeDisabled();
    await privacy.selectOption("SELF_ONLY");
    await expect(panel.getByLabel("Branded content", { exact: true })).toBeDisabled();
    await privacy.selectOption("PUBLIC_TO_EVERYONE");
    await panel.getByLabel("Your brand", { exact: true }).check();
    await expect(panel.getByText("Promotional content", { exact: true })).toBeVisible();
    await panel.getByLabel("Branded content", { exact: true }).check();
    await expect(panel.getByText("Paid partnership", { exact: true })).toBeVisible();
    const onlyMe = privacy.locator('option[value="SELF_ONLY"]');
    await expect(onlyMe).toHaveJSProperty("disabled", true);
    await expect(onlyMe).toHaveAttribute("title", "Branded content visibility cannot be set to private");
    await expect(panel.getByRole("link", { name: "Music Usage Confirmation" })).toBeVisible();
    await expect(panel.getByRole("link", { name: "Branded Content Policy" })).toBeVisible();
    await expect(panel.getByText(/Opublikujemy automatycznie/)).toContainText(/2030.*z tymi ustawieniami/);
    await expect(panel.getByText(/Opublikujemy automatycznie/)).toContainText(/\([A-Za-z_]+\/[A-Za-z_]+\)|\(UTC\)/);
    await expect(panel.getByLabel("TikTok video preview")).toHaveAttribute("controls", "");
    await expect(panel.getByLabel("TikTok video preview")).toHaveAttribute("src", "https://cdn.example.test/tt3.mp4");
    await expect.poll(() => panel.getByLabel("TikTok video preview").evaluate((el) => (el as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(1);
    await expect(panel.getByLabel("TikTok video preview").locator("img,canvas,svg")).toHaveCount(0);
    await expect(panel.getByText(/Processing may take a few minutes/)).toBeVisible();
    const consent = panel.getByLabel("I confirm this TikTok submission with these settings.");
    await consent.check();
    await expect(submit).toBeEnabled();
    await schedule.fill("2030-01-15T15:30");
    await expect(consent).not.toBeChecked();
    await expect(submit).toBeDisabled();
    await consent.check();
    await page.getByLabel("TikTok caption", { exact: true }).fill("Final reviewed caption");
    await expect(consent).not.toBeChecked();
    await consent.check();
    await page.screenshot({ path: testInfo.outputPath(`compose-${viewport.width}.png`), fullPage: true });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await submit.click();
    await expect(page).toHaveURL(/\/content\/[\w-]+$/);
    const client = new Client({ connectionString: E2E_DATABASE_URL });
    await client.connect();
    try {
      const { rows } = await client.query(`SELECT p.*, d.payload FROM posts p JOIN deliveries d ON d.id=p.delivery_id WHERE p.content_id=$1`, [page.url().split("/").pop()]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "scheduled", tiktok_publish_mode: "direct", tiktok_privacy_level: "PUBLIC_TO_EVERYONE", tiktok_disable_comment: true, tiktok_disable_duet: false, tiktok_disable_stitch: true, tiktok_brand_content_toggle: true, tiktok_brand_organic_toggle: true });
      expect(rows[0].payload.caption).toBe("Final reviewed caption");
      const audit = await client.query("SELECT * FROM audit_logs WHERE target_id=$1 AND action='tiktok.submission_confirmed'", [rows[0].content_id]);
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].metadata.mode).toBe("schedule");
    } finally { await client.end(); }
    expect(errors).toEqual([]);
  });

  test(`TikTok cannot-post at ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await creatorToken("cannot-post");
    await openComposer(page);
    await page.getByRole("button", { name: "Publish now", exact: true }).click();
    const panel = page.getByRole("region", { name: "TikTok publishing" });
    await expect(panel.getByText(/Try again later/)).toBeVisible();
    await panel.getByLabel("I confirm this TikTok submission with these settings.").check();
    await expect(page.locator('button[type="submit"]')).toBeDisabled();
  });
}

for (const width of [1440, 390]) {
  test(`held TikTok confirmation and processing at ${width}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await creatorToken("available");
    const client = new Client({ connectionString: E2E_DATABASE_URL });
    await client.connect();
    let id = "";
    try {
      const { rows } = await client.query(`INSERT INTO deliveries (workspace_id,channel_id,format,status,tiktok_confirmation,payload,scheduled_at,last_error)
        SELECT c.workspace_id,c.id,'video','held','required',jsonb_build_object('format','video','caption','Scheduled caption','media',jsonb_build_array(jsonb_build_object('mediaId',m.id)),'options',jsonb_build_object('publishMode','direct','privacyLevel','SELF_ONLY')),now(),'TikTok settings changed. Review and confirm again.'
        FROM channels c JOIN media m ON m.workspace_id=c.workspace_id AND m.url='https://cdn.example.test/tt3.mp4' WHERE c.platform_id='tt_e2e_1' LIMIT 1 RETURNING id`);
      id = rows[0].id;
      await page.goto(`/queue/${id}`);
      await page.getByRole("link", { name: "Review TikTok settings" }).click();
      const panel = page.getByRole("region", { name: "TikTok publishing" });
      await expect(panel.getByText("TT3 Creator", { exact: true })).toBeVisible();
      await expect(page.locator(".nav-locked")).toHaveCount(0);
      await expect(page.getByLabel("TikTok privacy")).toHaveValue("");
      await expect(panel.getByLabel("Allow Comment", { exact: true })).not.toBeChecked();
      await expect(panel.getByLabel("Allow Comment", { exact: true })).toBeDisabled();
      const submit = page.getByRole("button", { name: "Publish now", exact: true });
      await expect(submit).toBeDisabled();
      await page.getByLabel("TikTok privacy").selectOption("SELF_ONLY");
      await page.getByLabel("TikTok caption", { exact: true }).fill("Current confirmed caption");
      await panel.getByLabel("I confirm this TikTok submission with these settings.").check();
      await expect(submit).toBeEnabled();
      await page.getByLabel("TikTok caption", { exact: true }).fill("Final confirmed caption");
      await expect(submit).toBeDisabled();
      await panel.getByLabel("I confirm this TikTok submission with these settings.").check();
      const preview = panel.getByLabel("TikTok video preview");
      await preview.evaluate((el) => (el as HTMLVideoElement).play());
      await expect.poll(() => preview.evaluate((el) => (el as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
      await preview.evaluate((el) => (el as HTMLVideoElement).pause());
      await expect(submit).toBeEnabled();
      await expect(panel.getByLabel("I confirm this TikTok submission with these settings.")).toBeChecked();
      await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); window.scrollTo(0, 0); });
      await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
      await page.screenshot({ path: testInfo.outputPath(`confirmation-${width}.png`), fullPage: true, animations: "disabled" });
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await submit.click();
      await expect(page).toHaveURL(new RegExp(`/queue/${id}$`));
      const saved = await client.query("SELECT status,tiktok_confirmation,payload FROM deliveries WHERE id=$1", [id]);
      expect(saved.rows[0]).toMatchObject({ status: "scheduled", tiktok_confirmation: "confirmed", payload: { caption: "Final confirmed caption", options: { privacyLevel: "SELF_ONLY", disableComment: true } } });
      await client.query("UPDATE deliveries SET status='processing',provider_handle='tt-processing-1' WHERE id=$1", [id]);
      await page.reload();
      await expect(page.locator("#post-detail-head").getByText("processing", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath(`processing-${width}.png`), fullPage: true, animations: "disabled" });
      expect(errors).toEqual([]);
    } finally {
      if (id) await client.query("DELETE FROM deliveries WHERE id=$1", [id]);
      await client.end();
    }
  });
}

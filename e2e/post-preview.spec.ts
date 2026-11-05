import tiktokDocs from "../tests/fixtures/provider-docs/tiktok.json";
import tiktokRecorded from "../src/lib/providers/__fixtures__/recorded/tiktok-direct-self-only.json";
import tiktokInbox from "../src/lib/providers/__fixtures__/recorded/tiktok-inbox.json";
import publishDocs from "../tests/fixtures/provider-docs/publish-responses.json";
import { test, expect, type Page } from "@playwright/test";
import { Client } from "pg";
import { setPro, gotoOk, watchConsole } from "./helpers";
import { E2E_BASE_URL, E2E_DATABASE_URL } from "./env";

// POSTPREVIEW1: one published-post card in Engagement, Queue, Content and Activity. The thumbnail is an
// checked-in image served by the browser fixture, independent of the marketing-site build.
const IMAGE = `${E2E_BASE_URL}/og.png`;
const OURS = "Our autumn workshop is live: three evenings of hands-on n8n, recordings included for everyone who signs up.";
const THEIRS = "Posted by hand on the Page: behind the scenes of the new studio.";

let db: Client;
let workspaceId: string;
let channelId: string;
let deliveryId: string;
let contentId: string;
let eventId: string;

test.beforeEach(async ({ page }) => {
  await page.route(IMAGE, route => route.fulfill({ path: "landing/public/og.png", contentType: "image/png" }));
});

test.beforeAll(async () => {
  db = new Client({ connectionString: E2E_DATABASE_URL });
  await db.connect();
  const { rows: [ch] } = await db.query<{ id: string; workspace_id: string }>("SELECT id, workspace_id FROM channels WHERE platform = 'facebook' LIMIT 1");
  channelId = ch!.id;
  workspaceId = ch!.workspace_id;
  const { rows: [m] } = await db.query<{ id: string }>(
    "INSERT INTO media (workspace_id, checksum, storage_key, url, kind, mime) VALUES ($1, 'postpreview-e2e', 'k', $2, 'image', 'image/png') RETURNING id", [workspaceId, IMAGE]);
  const { rows: [d] } = await db.query<{ id: string }>(
    `INSERT INTO deliveries (workspace_id, channel_id, format, status, payload, scheduled_at, provider_handle)
     VALUES ($1, $2, 'post', 'sent', $3, now() - interval '2 hours', 'pp_ours_1') RETURNING id`,
    [workspaceId, channelId, JSON.stringify({ format: "post", media: [{ mediaId: m!.id }], caption: OURS })]);
  deliveryId = d!.id;
  const { rows: [ct] } = await db.query<{ id: string }>("INSERT INTO content (workspace_id, title) VALUES ($1, 'Post preview e2e') RETURNING id", [workspaceId]);
  contentId = ct!.id;
  await db.query(
    `INSERT INTO posts (workspace_id, content_id, delivery_id, platform, status, description, published_url, published_at, platform_post_id)
     VALUES ($1, $2, $3, 'facebook', 'published', $4, 'https://www.facebook.com/fb_e2e_1/posts/1', now() - interval '2 hours', 'pp_ours_1')`,
    [workspaceId, contentId, deliveryId, OURS]);
  await db.query(
    `INSERT INTO post_previews (workspace_id, channel_id, post_id, status, text, image_url, permalink, posted_at)
     VALUES ($1, $2, 'pp_ext_1', 'ready', $3, $4, 'https://www.facebook.com/fb_e2e_1/posts/2', now() - interval '1 day')`,
    [workspaceId, channelId, THEIRS, IMAGE]);
  await db.query(
    `INSERT INTO post_reactions (workspace_id, channel_id, post_id, reactor_id, reactor_name, reaction_type)
     VALUES ($1, $2, 'pp_ours_1', 'pp1', 'Ada', 'love'), ($1, $2, 'pp_ext_1', 'pp2', 'Bo', 'like')`, [workspaceId, channelId]);
  const { rows: [ev] } = await db.query<{ id: string }>(
    "INSERT INTO events (workspace_id, type, subject_type, subject_id, payload) VALUES ($1, 'post.published', 'post', $2, $3) RETURNING id",
    [workspaceId, deliveryId, JSON.stringify({ platform: "facebook", channelId, deliveryId, providerHandle: "pp_ours_1", status: "published" })]);
  eventId = ev!.id;
});

test.afterAll(async () => {
  await db.query("DELETE FROM post_reactions WHERE workspace_id = $1 AND post_id LIKE 'pp\\_%'", [workspaceId]);
  await db.query("DELETE FROM post_previews WHERE workspace_id = $1 AND post_id LIKE 'pp\\_%'", [workspaceId]);
  await db.query("DELETE FROM events WHERE id = $1", [eventId]);
  await db.query("DELETE FROM content WHERE id = $1", [contentId]);
  await db.query("DELETE FROM posts WHERE delivery_id = $1", [deliveryId]);
  await db.query("DELETE FROM deliveries WHERE id = $1", [deliveryId]);
  await db.query("DELETE FROM media WHERE workspace_id = $1 AND checksum = 'postpreview-e2e'", [workspaceId]);
  await db.end();
});

async function shoot(page: Page, base: string) {
  for (const theme of ["dark", "light"]) {
    await page.context().addCookies([{ name: "ps_theme", value: theme, url: page.url() }]);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expectCard(page, null);
    await page.screenshot({ path: `${base}-${theme}.png`, animations: "disabled" });
  }
  await page.context().clearCookies({ name: "ps_theme" });
}

async function expectCard(page: Page, text: string | null) {
  const card = page.locator("[data-post-preview]").first();
  await expect(card).toBeVisible();
  if (text) await expect(card).toContainText(text.slice(0, 40));
  await expect.poll(() => card.locator("img").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  // The card never pushes the page sideways, even at phone width.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

const PLACES = () => [
  { name: "engagement-external", path: `/engagement?open=${encodeURIComponent(`${channelId}~pp_ext_1`)}`, text: THEIRS },
  { name: "engagement-ours", path: `/engagement?open=${encodeURIComponent(`${channelId}~pp_ours_1`)}`, text: OURS },
  { name: "queue", path: `/queue?open=${deliveryId}`, text: OURS },
  { name: "content", path: `/content/${contentId}`, text: OURS },
  { name: "activity", path: `/activity?source=events&open=${eventId}`, text: OURS },
];

for (const viewport of [{ label: "desktop", width: 1440, height: 900 }, { label: "phone", width: 390, height: 844 }]) {
  test(`the published-post card shows in every place that points at a post (${viewport.label})`, async ({ page }, testInfo) => {
    const { errors } = watchConsole(page);
    await setPro(page.request);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    for (const place of PLACES()) {
      await gotoOk(page, place.path);
      await expectCard(page, place.text);
      await expect(page.locator("[data-post-preview] a.post-preview-link").first()).toHaveAttribute("href", /^https:\/\/www\.facebook\.com\//);
      await shoot(page, testInfo.outputPath(`${place.name}-${viewport.label}`));
    }
    expect(errors).toEqual([]);
  });
}


test("TikTok and X cards expose the right destination and label", async ({ page }, testInfo) => {
  await setPro(page.request);
  const { rows: [original] } = await db.query("SELECT platform, username FROM channels WHERE id=$1", [channelId]);
  try {
    for (const sample of [
      { platform: "tiktok", handle: tiktokRecorded.providerHandle, url: "https://www.tiktok.com/@test_creator", label: "View channel profile", publishedUrl: null },
      { platform: "tiktok", handle: tiktokInbox.providerHandle, url: "https://www.tiktok.com/@test_creator", label: "View channel profile", publishedUrl: null },
      // No recorded X channel: this id comes from the documented create-post response.
      { platform: "twitter", handle: publishDocs.x.createPost.body.data.id, url: `https://x.com/i/web/status/${publishDocs.x.createPost.body.data.id}`, label: "View on X", publishedUrl: null },
      // Sandbox recordings are SELF_ONLY; the public id shape is documented, not recorded.
      { platform: "tiktok", handle: tiktokRecorded.providerHandle, url: `https://www.tiktok.com/@test_creator/video/${tiktokDocs.status.complete.body.data.publicaly_available_post_id[0]}`, label: "View on TikTok", publishedUrl: `https://www.tiktok.com/@test_creator/video/${tiktokDocs.status.complete.body.data.publicaly_available_post_id[0]}` },
    ]) {
      await db.query("UPDATE channels SET platform=$1, username='test_creator' WHERE id=$2", [sample.platform, channelId]);
      await db.query("UPDATE deliveries SET provider_handle=$1 WHERE id=$2", [sample.handle, deliveryId]);
      await db.query("UPDATE posts SET published_url=$1 WHERE delivery_id=$2", [sample.publishedUrl, deliveryId]);
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await gotoOk(page, `/queue?open=${deliveryId}`);
        const link = page.locator(".post-preview-link");
        await expect(link).toHaveAttribute("href", sample.url);
        await expect(link).toContainText(sample.label);
        await shoot(page, testInfo.outputPath(`${sample.platform}-${sample.label.replaceAll(" ", "-")}-${width}`));
      }
    }
  } finally {
    await db.query("UPDATE channels SET platform=$1, username=$2 WHERE id=$3", [original.platform, original.username, channelId]);
    await db.query("UPDATE deliveries SET provider_handle='pp_ours_1' WHERE id=$1", [deliveryId]);
    await db.query("UPDATE posts SET published_url='https://www.facebook.com/fb_e2e_1/posts/1' WHERE delivery_id=$1", [deliveryId]);
  }
});

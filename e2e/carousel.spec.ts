import { test, expect } from "@playwright/test";
import { Client } from "pg";
import { E2E_BASE_URL, E2E_DATABASE_URL } from "./env";
import { watchConsole } from "./helpers";

for (const [platform, count] of [["instagram", 2], ["facebook", 10]] as const) {
test(`API ${platform} carousel counts ${count} slides and keeps every slide when Queue edits its text`, async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const { errors } = watchConsole(page);
  await page.route("https://cdn.example/**", route => route.fulfill({
    contentType: "image/svg+xml",
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="#406080"/></svg>',
  }));
  const client = new Client({ connectionString: E2E_DATABASE_URL });
  await client.connect();
  let postId = ""; let deliveryId = ""; let contentId = "";
  const mediaIds: string[] = [];
  try {
    const { rows: [channel] } = await client.query("select id, workspace_id from channels where platform=$1 order by created_at limit 1", [platform]);
    const mediaUrls = Array.from({ length: count }, (_, i) => `https://cdn.example/${platform}-carousel-${i}`);
    const content = await page.request.post("/api/v1/content", { data: { title: `Carousel ${platform}`, mediaUrls } });
    expect(content.status()).toBe(201); contentId = (await content.json()).data.id;
    for (const [index, url] of mediaUrls.entries()) {
      const { rows: [media] } = await client.query("insert into media(workspace_id,checksum,storage_key,url,kind) values($1,$2,$2,$3,'image') returning id", [channel.workspace_id, `carousel-e2e-${platform}-${index}`, url]);
      mediaIds.push(media.id);
    }
    const created = await page.request.post("/api/v1/posts", { data: { platform, contentId, mediaUrls, description: "Carousel before edit" } });
    expect(created.status()).toBe(201); postId = (await created.json()).data.id;
    const scheduled = await page.request.post(`/api/v1/posts/${postId}/publish`, { data: { channelId: channel.id, when: "2030-01-15T14:30:00Z" } });
    expect(scheduled.status()).toBe(200);
    const delivery = (await scheduled.json()).data.delivery; deliveryId = delivery.id;
    expect(delivery.format).toBe("carousel");
    expect(delivery.payload.media.map((m: { mediaId: string }) => m.mediaId)).toEqual(mediaIds);
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const theme of ["dark", "light"]) {
        await page.context().addCookies([{ name: "ps_theme", value: theme, url: E2E_BASE_URL }]);
        for (const path of [`/queue?q=Carousel&open=${deliveryId}`, `/queue?status=scheduled&q=Carousel&open=${deliveryId}`, `/content/${contentId}`]) {
          await page.goto(path);
          const scope = path.startsWith("/queue") ? page.locator(".dl-detail") : page.locator(`#post-card-${postId}`);
          await expect(scope.locator("[data-media-count] .panel-count")).toHaveText(String(count));
          await expect(scope.locator("[data-media-count]")).toContainText("Media");
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          await page.screenshot({ path: testInfo.outputPath(`${platform}-${width}-${theme}-${path.split("?")[0].replaceAll("/", "_")}-${path.includes("status=")}.png`), fullPage: true });
        }
      }
    }
    await page.goto(`/queue?open=${deliveryId}`);
    const panel = page.locator(".dl-detail");
    await expect(panel).toBeVisible();
    await panel.getByLabel("Text").fill("Carousel after edit");
    await panel.getByRole("button", { name: "Save text", exact: true }).click();
    await expect(page.locator(".toasts")).toContainText("Text saved.");
    const { rows: [saved] } = await client.query("select payload from deliveries where id=$1", [deliveryId]);
    expect(saved.payload.media).toEqual(delivery.payload.media);
    expect(saved.payload.caption).toBe("Carousel after edit");
    await page.goto(`/queue/${deliveryId}`);
    const mediaPanel = page.locator(".panel").filter({ has: page.getByRole("heading", { name: "Media", exact: true }) });
    await expect(mediaPanel.locator(".panel-count")).toHaveText(String(count));
    await expect(mediaPanel.locator("img")).toHaveCount(count);
    await page.screenshot({ path: testInfo.outputPath("carousel-media.png"), fullPage: true });
    expect(errors).toEqual([]);
  } finally {
    if (contentId) await client.query("delete from content where id=$1", [contentId]);
    if (postId) await client.query("delete from posts where id=$1", [postId]);
    if (deliveryId) {
      await client.query("select graphile_worker.remove_job($1)", [`publish:${deliveryId}`]);
      await client.query("delete from deliveries where id=$1", [deliveryId]);
    }
    for (const id of mediaIds) await client.query("delete from media where id=$1", [id]);
    await client.end();
  }
});

}

test("Facebook video carousel availability explains access and validates the actual destination", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const client = new Client({ connectionString: E2E_DATABASE_URL });
  await client.connect();
  let channelId = ""; let workspaceId = ""; let postId = ""; let deliveryId = "";
  const mediaIds: string[] = [];
  try {
    const { rows: [workspace] } = await client.query("SELECT workspace_id FROM channels WHERE platform_id='fb_e2e_1'");
    workspaceId = workspace.workspace_id;
    const { rows: [channel] } = await client.query("INSERT INTO channels(workspace_id,platform,platform_id,display_name,token_encrypted,webhook_secret) VALUES($1,'facebook','fb-video-carousel-e2e','Video carousel test','unused','test') RETURNING id", [workspaceId]);
    channelId = channel.id;
    const mediaUrls = ["https://cdn.example/carousel-photo", "https://cdn.example/carousel-video"];
    for (const [i, url] of mediaUrls.entries()) {
      const { rows: [media] } = await client.query("INSERT INTO media(workspace_id,checksum,storage_key,url,kind) VALUES($1,$2,$2,$3,$4) RETURNING id", [workspaceId, `fb-video-carousel-${i}`, url, i ? "video" : "image"]);
      mediaIds.push(media.id);
    }
    const created = await page.request.post("/api/v1/posts", { data: { platform: "facebook", mediaUrls, description: "Video carousel" } });
    expect(created.status()).toBe(201); postId = (await created.json()).data.id;
    const hint = "Video in Facebook carousels requires a verified Meta app with ads permission (pages_manage_ads) for this Page.";
    for (const state of ["unknown", "unavailable", "available"]) {
      await client.query("UPDATE channels SET video_carousel=$1 WHERE id=$2 AND workspace_id=$3", [state, channelId, workspaceId]);
      const response = await page.request.post(`/api/v1/posts/${postId}/publish`, { data: { channelId, when: "2030-01-15T14:30:00Z" } });
      expect(response.status()).toBe(state === "available" ? 200 : 422);
      if (state === "available") deliveryId = (await response.json()).data.delivery.id;
      else expect(JSON.stringify(await response.json())).toContain(hint);
      const channels = await page.request.get("/api/v1/channels");
      const exposed = (await channels.json()).data.find((row: { id: string }) => row.id === channelId);
      expect(exposed.video_carousel).toBe(state);
      expect(exposed.capabilities.includes("video_carousel")).toBe(state === "available");
      for (const width of [390, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        for (const theme of ["dark", "light"]) {
          await page.context().addCookies([{ name: "ps_theme", value: theme, url: E2E_BASE_URL }]);
          await page.goto(`/channels/${channelId}`);
          await expect(page.locator(`[aria-disabled="${state !== "available"}"]`).filter({ hasText: "video carousel" })).toBeVisible();
          if (state !== "available") await expect(page.getByText(hint, { exact: true })).toBeVisible();
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          await page.screenshot({ path: testInfo.outputPath(`video-carousel-${state}-${width}-${theme}.png`), fullPage: true });
        }
      }
    }
    const { rows: [count] } = await client.query("SELECT count(*)::int AS n FROM deliveries WHERE workspace_id=$1 AND channel_id=$2", [workspaceId, channelId]);
    expect(count.n).toBe(1);
  } finally {
    if (postId) await client.query("DELETE FROM posts WHERE id=$1 AND workspace_id=$2", [postId, workspaceId]);
    if (deliveryId) {
      await client.query("SELECT graphile_worker.remove_job($1)", [`publish:${deliveryId}`]);
      await client.query("DELETE FROM deliveries WHERE id=$1 AND workspace_id=$2", [deliveryId, workspaceId]);
    }
    await client.query("DELETE FROM media WHERE id=ANY($1::uuid[]) AND workspace_id=$2", [mediaIds, workspaceId]);
    if (channelId) await client.query("DELETE FROM channels WHERE id=$1 AND workspace_id=$2", [channelId, workspaceId]);
    await client.end();
  }
});

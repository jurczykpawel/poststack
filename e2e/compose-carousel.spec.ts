import { test, expect } from "@playwright/test";
import { Client } from "pg";
import { E2E_BASE_URL, E2E_DATABASE_URL } from "./env";
import { setPro, watchConsole } from "./helpers";

const uploadPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");

test("Compose schedules three Instagram slides in the chosen order and Queue preserves them", async ({ page }, info) => {
  test.setTimeout(120_000);
  await setPro(page.request);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const { errors } = watchConsole(page);
  const urls = [1, 2, 3].map(i => `https://cdn.example/compose-slide-${i}.png`);
  await page.route("https://cdn.example/**", route => {
    const slide = Number(route.request().url().match(/slide-(\d)/)?.[1] ?? 1);
    return route.fulfill({ contentType: "image/svg+xml", body: `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="${["", "#427d93", "#84644a", "#626998"][slide]}"/><text x="100" y="125" text-anchor="middle" font-size="80" fill="white">${slide}</text></svg>` });
  });
  const client = new Client({ connectionString: E2E_DATABASE_URL });
  await client.connect();
  let contentId = ""; let deliveryId = ""; let workspaceId = "";
  try {
    const { rows: [channel] } = await client.query("select id,workspace_id from channels where platform='instagram' limit 1");
    workspaceId = channel.workspace_id;
    for (const [i, url] of urls.entries()) await client.query("insert into media(workspace_id,checksum,storage_key,url,kind) values($1,$2,$2,$3,'image')", [channel.workspace_id, `compose-slide-${i}`, url]);
    await page.goto("/compose");
    await page.getByRole("button", { name: "Brand", exact: true }).click();
    await page.getByRole("option", { name: "E2E Brand", exact: true }).click();
    for (const platform of ["Facebook", "TikTok"]) await page.locator(".target").filter({ hasText: platform }).click();
    await page.getByLabel("Title (internal)").fill("Compose carousel order");
    await page.getByLabel("Media URL", { exact: true }).fill(urls[0]);
    await expect(page.getByRole("button", { name: "Add media", exact: true })).toBeVisible();
    for (const url of urls.slice(1)) {
      await page.getByRole("button", { name: "Add media", exact: true }).click();
      await page.getByLabel("Additional media URL").fill(url);
      await page.getByRole("button", { name: "Add URL", exact: true }).click();
    }
    await expect(page.locator("[data-compose-slide]")).toHaveCount(3);
    await expect(page.getByText("Carousel (2–10 media)", { exact: true }).filter({ visible: true })).toBeVisible();
    await page.getByRole("button", { name: "Move media 3 up", exact: true }).focus();
    await page.keyboard.press("Enter");
    expect(await page.locator("[data-compose-slide] img").evaluateAll(els => els.map(el => el.getAttribute("src")))).toEqual([urls[0], urls[2], urls[1]]);
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const theme of ["dark", "light"]) {
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        await expect(page.locator(".pv-card [data-carousel-count]")).toHaveText("1 / 3");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.evaluate(() => { (document.activeElement as HTMLElement)?.blur(); window.scrollTo(0, 0); });
        await page.screenshot({ path: info.outputPath(`compose-${width}-${theme}.png`), fullPage: true });
      }
    }
    await page.getByRole("button", { name: "Schedule", exact: true }).click();
    await page.locator('input[type="datetime-local"]').fill("2035-01-15T14:30");
    await page.locator(".compose-pubbar button[type=submit]").click();
    await expect(page).toHaveURL(/\/content\/[0-9a-f-]+$/);
    contentId = new URL(page.url()).pathname.split("/").pop()!;
    const posts = (await (await page.request.get(`/api/v1/posts?contentId=${contentId}`)).json()).data.items;
    const post = posts.find((p: { contentId: string }) => p.contentId === contentId);
    expect(post.mediaUrls).toEqual([urls[0], urls[2], urls[1]]);
    deliveryId = post.deliveryId;
    expect(deliveryId).toBeTruthy();
    await page.goto(`/queue?open=${deliveryId}`);
    await page.locator(".dl-detail").getByLabel("Text").fill("Edited carousel caption");
    await page.getByRole("button", { name: "Save text", exact: true }).click();
    await expect(page.locator(".toasts")).toContainText("Text saved.");
    const { rows: [delivery] } = await client.query("select format,payload,status from deliveries where id=$1", [deliveryId]);
    expect(delivery).toMatchObject({ format: "carousel", status: "scheduled" });
    const { rows } = await client.query("select id,url from media where workspace_id=$1 and url=any($2::text[])", [channel.workspace_id, urls]);
    expect(delivery.payload.media.map((m: { mediaId: string }) => rows.find(r => r.id === m.mediaId)?.url)).toEqual([urls[0], urls[2], urls[1]]);
    expect(errors).toEqual([]);
    await page.context().addCookies([{ name: "ps_theme", value: "dark", url: E2E_BASE_URL }]);
  } finally {
    if (contentId) await client.query("delete from content where id=$1 and workspace_id=$2", [contentId, workspaceId]);
    if (deliveryId) {
      await client.query("select graphile_worker.remove_job($1)", [`publish:${deliveryId}`]);
      await client.query("delete from deliveries where id=$1 and workspace_id=$2", [deliveryId, workspaceId]);
    }
    await client.query("delete from media where checksum like 'compose-slide-%' and workspace_id=$1", [workspaceId]);
    await client.end();
  }
});

test("Compose adds library and uploaded media, removes slides, and explains channel limits on mobile", async ({ page }, info) => {
  await setPro(page.request);
  await page.route("**/media/sha256/*.png", route => route.fulfill({ contentType: "image/png", body: uploadPng }));
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto("/compose");
  await page.getByRole("button", { name: "Brand", exact: true }).click();
  await page.getByRole("option", { name: "E2E Brand", exact: true }).click();
  await expect(page.getByRole("button", { name: "Add media", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add media", exact: true }).click();
  await page.getByLabel("Upload media").setInputFiles({ name: "slide.png", mimeType: "image/png", buffer: uploadPng });
  await expect(page.locator("[data-compose-slide]")).toHaveCount(1);
  await page.getByRole("button", { name: "Add media", exact: true }).click();
  await page.getByRole("button", { name: "Media library", exact: true }).click();
  await page.locator("[data-library-media]").first().click();
  await expect(page.locator("[data-compose-slide]")).toHaveCount(2);
  // CA-TTPHOTO1: TikTok publishes image carousels as photo posts.
  await expect(page.locator(".target").filter({ hasText: "TikTok" })).not.toContainText("unsupported format");
  const originalUrl = await page.getByLabel("Media URL", { exact: true }).inputValue();
  await page.getByLabel("Media URL", { exact: true }).fill("https://cdn.example.test/tt3.mp4");
  await expect(page.locator(".target").filter({ hasText: "Facebook" })).toContainText("Video in Facebook carousels requires a verified Meta app with ads permission (pages_manage_ads) for this Page.");
  await expect(page.locator(".compose-pubbar button[type=submit]")).toBeDisabled();
  await page.getByLabel("Media URL", { exact: true }).fill(originalUrl);
  await page.locator("[data-compose-slide]").first().getByRole("button", { name: "Media actions" }).click();
  await page.getByRole("button", { name: "Remove media 1", exact: true }).click();
  await expect(page.locator("[data-compose-slide]")).toHaveCount(1);
  await expect(page.locator(".target").filter({ hasText: "TikTok" })).not.toContainText("unsupported format");
  for (let i = 1; i < 10; i++) {
    await page.getByRole("button", { name: "Add media", exact: true }).click();
    await page.locator("[data-library-media]").first().click();
  }
  await expect(page.locator("[data-compose-slide]")).toHaveCount(10);
  await expect(page.getByRole("button", { name: "Add media", exact: true })).toBeDisabled();
  await page.screenshot({ path: info.outputPath("compose-ten-mobile.png"), fullPage: true });
  const overflow = await page.evaluate(() => Array.from(document.querySelectorAll("main *")).filter(el => el.getBoundingClientRect().right > innerWidth + 1).map(el => ({ tag: el.tagName, cls: el.className, right: el.getBoundingClientRect().right })).slice(0, 10));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), JSON.stringify(overflow)).toBe(true);
});

test("Compose schedules twenty mixed Threads items and explains smaller destination limits", async ({ page }, info) => {
  test.setTimeout(120_000);
  await setPro(page.request);
  const { errors } = watchConsole(page);
  const client = new Client({ connectionString: E2E_DATABASE_URL });
  await client.connect();
  let workspaceId = "", channelId = "", contentId = "", deliveryId = "";
  const urls = Array.from({ length: 20 }, (_, i) => `https://cdn.example/threads-compose-${i}.${i % 2 ? "mp4" : "png"}`);
  await page.route("https://cdn.example/**", route => route.fulfill({ contentType: "image/png", body: uploadPng }));
  try {
    const { rows: [channel] } = await client.query("insert into channels(workspace_id,platform,platform_id,display_name,token_encrypted,webhook_secret,status,connection_mode,brand_key) select workspace_id,'threads','threads-compose','E2E Threads',token_encrypted,'fixture','active','manual_token',brand_key from channels where platform='instagram' limit 1 returning id,workspace_id");
    workspaceId = channel.workspace_id; channelId = channel.id;
    for (const [i, url] of urls.entries()) await client.query("insert into media(workspace_id,checksum,storage_key,url,kind) values($1,$2,$2,$3,$4)", [workspaceId, `threads-compose-${i}`, url, i % 2 ? "video" : "image"]);
    await page.goto("/compose");
    await page.getByRole("button", { name: "Brand", exact: true }).click();
    await page.getByRole("option", { name: "E2E Brand", exact: true }).click();
    for (const name of ["Facebook", "Instagram", "TikTok"]) await page.locator(".target").filter({ hasText: name }).click();
    await page.getByLabel("Title (internal)").fill("Threads twenty mixed items");
    await page.getByLabel("Media URL", { exact: true }).fill(urls[0]);
    for (const url of urls.slice(1)) {
      await page.getByRole("button", { name: "Add media", exact: true }).click();
      await page.getByLabel("Additional media URL").fill(url);
      await page.getByRole("button", { name: "Add URL", exact: true }).click();
    }
    await expect(page.locator("[data-compose-slide]")).toHaveCount(20);
    await expect(page.getByRole("button", { name: "Add media", exact: true })).toBeDisabled();
    await expect(page.getByText("Carousel (2–20 media)", { exact: true }).filter({ visible: true })).toBeVisible();
    await page.locator(".target").filter({ hasText: "Instagram" }).click();
    await expect(page.locator(".target").filter({ hasText: "Instagram" })).toContainText("Carousel allows at most 10 media items");
    await expect(page.locator(".compose-pubbar button[type=submit]")).toBeDisabled();
    await page.locator(".target").filter({ hasText: "Instagram" }).click();
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`threads-${width}.png`), fullPage: true });
    }
    await page.getByRole("button", { name: "Schedule", exact: true }).click();
    await page.locator('input[type="datetime-local"]').fill("2035-01-15T14:30");
    await page.locator(".compose-pubbar button[type=submit]").click();
    await expect(page).toHaveURL(/\/content\/[0-9a-f-]+$/);
    contentId = new URL(page.url()).pathname.split("/").pop()!;
    const { rows: [post] } = await client.query("select media_urls,delivery_id from posts where content_id=$1 and platform='threads'", [contentId]);
    deliveryId = post.delivery_id;
    expect(post.media_urls).toEqual(urls);
    const { rows: [delivery] } = await client.query("select format,payload,status from deliveries where id=$1", [deliveryId]);
    expect(delivery).toMatchObject({ format: "carousel", status: "scheduled" });
    expect(delivery.payload.media).toHaveLength(20);
    expect(errors).toEqual([]);
  } finally {
    if (contentId) await client.query("delete from content where id=$1", [contentId]);
    if (deliveryId) { await client.query("select graphile_worker.remove_job($1)", [`publish:${deliveryId}`]); await client.query("delete from deliveries where id=$1", [deliveryId]); }
    if (channelId) await client.query("delete from channels where id=$1", [channelId]);
    if (workspaceId) await client.query("delete from media where workspace_id=$1 and checksum like 'threads-compose-%'", [workspaceId]);
    await client.end();
  }
});

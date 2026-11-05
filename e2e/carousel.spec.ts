import { test, expect } from "@playwright/test";
import { Client } from "pg";
import { E2E_DATABASE_URL } from "./env";
import { watchConsole } from "./helpers";

test("API carousel keeps every slide when Queue edits its text", async ({ page }, testInfo) => {
  const { errors } = watchConsole(page);
  await page.route("https://cdn.example/**", route => route.fulfill({
    contentType: "image/svg+xml",
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="#406080"/></svg>',
  }));
  const client = new Client({ connectionString: E2E_DATABASE_URL });
  await client.connect();
  let postId = ""; let deliveryId = "";
  const mediaIds: string[] = [];
  try {
    const { rows: [channel] } = await client.query("select id, workspace_id from channels where platform='facebook' order by created_at limit 1");
    const mediaUrls = ["https://cdn.example/carousel-first", "https://cdn.example/carousel-second"];
    for (const [index, url] of mediaUrls.entries()) {
      const { rows: [media] } = await client.query("insert into media(workspace_id,checksum,storage_key,url,kind) values($1,$2,$2,$3,'image') returning id", [channel.workspace_id, `carousel-e2e-${index}`, url]);
      mediaIds.push(media.id);
    }
    const created = await page.request.post("/api/v1/posts", { data: { platform: "facebook", mediaUrls, description: "Carousel before edit" } });
    expect(created.status()).toBe(201); postId = (await created.json()).data.id;
    const scheduled = await page.request.post(`/api/v1/posts/${postId}/publish`, { data: { channelId: channel.id, when: "2030-01-15T14:30:00Z" } });
    expect(scheduled.status()).toBe(200);
    const delivery = (await scheduled.json()).data.delivery; deliveryId = delivery.id;
    expect(delivery.format).toBe("carousel");
    expect(delivery.payload.media.map((m: { mediaId: string }) => m.mediaId)).toEqual(mediaIds);
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
    await expect(mediaPanel.locator(".panel-count")).toHaveText("2");
    await page.screenshot({ path: testInfo.outputPath("carousel-media.png"), fullPage: true });
    expect(errors).toEqual([]);
  } finally {
    if (postId) await client.query("delete from posts where id=$1", [postId]);
    if (deliveryId) {
      await client.query("select graphile_worker.remove_job($1)", [`publish:${deliveryId}`]);
      await client.query("delete from deliveries where id=$1", [deliveryId]);
    }
    for (const id of mediaIds) await client.query("delete from media where id=$1", [id]);
    await client.end();
  }
});

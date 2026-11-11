import { test, expect } from "@playwright/test";
import { Client } from "pg";
import { E2E_DATABASE_URL } from "./env";
import { setPro, setFree } from "./helpers";

test("channel Story mode persists and compose overrides it", async ({ page }) => {
  await setPro(page.request);
  const client = new Client({ connectionString: E2E_DATABASE_URL });
  await client.connect();
  let workspaceId = "", channelId = "";
  try {
    const { rows: [ch] } = await client.query("select id,workspace_id from channels where platform='instagram' limit 1");
    workspaceId = ch.workspace_id; channelId = ch.id;
    await page.goto(`/channels/${ch.id}`);
    const panel = page.locator("#story-panel");
    await panel.getByRole("button", { name: "Default Story mode", exact: true }).click();
    await panel.getByRole("option", { name: "Post media (first item)", exact: true }).click();
    const saved = page.waitForResponse((r) => r.request().method() !== "GET" && r.url().includes(`/channels/${ch.id}`));
    await panel.getByRole("button", { name: "Save Story mode" }).click();
    await saved; // reload only after the save completed, otherwise it can race the request
    await page.reload();
    await expect(panel.locator("select[name=mode]")).toHaveValue("media");
    expect((await (await page.request.get(`/api/v1/channels/${ch.id}`)).json()).data).toMatchObject({ default_auto_story_mode: "media", default_auto_story: false });
    await page.goto("/compose");
    await page.getByRole("button", { name: "Brand", exact: true }).click();
    await page.getByRole("option", { name: "E2E Brand", exact: true }).click();
    await page.getByLabel("Title (internal)").fill("Story mode E2E");
    await page.getByLabel("Media URL", { exact: true }).fill("https://example.com/story.jpg");
    const automation = page.locator("details.auto").filter({ has: page.locator("summary", { hasText: "Instagram" }) });
    await automation.locator("summary").click();
    await expect(automation.locator("select")).toHaveValue("");
    await automation.locator("select").selectOption("card");
    await page.locator("form.compose-form button[type='submit']").click();
    await expect(page).toHaveURL(/\/content\//);
    const { rows } = await client.query("select auto_story_mode from posts where workspace_id=$1 and content_id in (select id from content where title='Story mode E2E' and workspace_id=$1) and platform='instagram'", [workspaceId]);
    expect(rows).toEqual([{ auto_story_mode: "card" }]);
    await setFree(page.request);
    const denied = await page.request.patch(`/api/v1/channels/${ch.id}`, { data: { default_auto_story_mode: "card" } });
    expect(denied.status()).toBe(402);
  } finally {
    await client.query("delete from content where workspace_id=$1 and title='Story mode E2E'", [workspaceId]);
    await client.query("update channels set default_auto_story_mode='card' where id=$1 and workspace_id=$2", [channelId, workspaceId]);
    await client.end();
  }
});

test("Facebook Auto-Story panel links to the Page's reel composer; Instagram shows no hint", async ({ page }) => {
  const client = new Client({ connectionString: E2E_DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query<{ id: string; platform: string; platform_id: string }>(
      "select distinct on (platform) id, platform, platform_id from channels where platform in ('facebook','instagram') order by platform, created_at");
    const fb = rows.find((r) => r.platform === "facebook")!;
    const ig = rows.find((r) => r.platform === "instagram")!;
    await page.goto(`/channels/${fb.id}`);
    const hint = page.locator("#story-panel [data-fb-reel-story-hint]");
    await expect(hint.getByRole("link", { name: "Check it in the reel composer" }))
      .toHaveAttribute("href", `https://business.facebook.com/latest/reels_composer/?asset_id=${encodeURIComponent(fb.platform_id)}`);
    await expect(hint.getByRole("link", { name: "How to turn it off" }))
      .toHaveAttribute("href", /docs\/STORIES\.md#facebook-adds-a-shortened-reel-preview-to-your-story$/);
    await page.goto(`/channels/${ig.id}`);
    await expect(page.locator("#story-panel")).toBeVisible();
    await expect(page.locator("[data-fb-reel-story-hint]")).toHaveCount(0);
  } finally {
    await client.end();
  }
});

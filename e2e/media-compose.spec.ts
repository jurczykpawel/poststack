import { test, expect } from "@playwright/test";
import { Client } from "pg";
import { E2E_DATABASE_URL } from "./env";
import { setPro } from "./helpers";

const imageUrl = "https://cdn.example.test/compose.png";

test("Compose schedules a small image and brand slot counts update in place", async ({ page }, testInfo) => {
  await setPro(page.request);
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto("/brands");
  const card = page.locator("#brand-e2e-brand");
  const slot = page.locator("#slot-e2e-brand-facebook select");
  const selected = await slot.locator("option:checked").innerText();
  const count = card.locator(".panel-count");
  const initialCount = Number((await count.innerText()).split(" ")[0]);
  await page.getByRole("button", { name: "Facebook channel for e2e-brand", exact: true }).click();
  await page.locator("#slot-e2e-brand-facebook").getByRole("option", { name: "— not set —", exact: true }).click();
  await expect(count).toHaveText(`${initialCount - 1} channels`);
  await page.getByRole("button", { name: "Facebook channel for e2e-brand", exact: true }).click();
  await page.locator("#slot-e2e-brand-facebook").getByRole("option", { name: selected, exact: true }).click();
  await expect(count).toHaveText(`${initialCount} channels`);
  await page.goto("/compose");
  await page.getByRole("button", { name: "Brand", exact: true }).click();
  await page.getByRole("option", { name: "E2E Brand", exact: true }).click();
  // Keep only the Facebook channel.
  await page.locator(".target").filter({ hasText: "Instagram" }).click();
  await page.locator(".target").filter({ hasText: "TikTok" }).click();
  await page.getByRole("button", { name: "Content type", exact: true }).click();
  await page.getByRole("option", { name: "Image", exact: true }).click();
  await page.getByLabel("Title (internal)").fill("Async media image regression");
  await page.getByLabel("Media URL", { exact: true }).fill(imageUrl);
  await page.getByRole("button", { name: "Schedule", exact: true }).click();
  await page.locator('input[type="datetime-local"]').fill("2030-01-15T14:30");
  await page.getByRole("button", { name: "Schedule →", exact: true }).click();
  await expect(page).toHaveURL(/\/content\/[0-9a-f-]+$/);
  const client = new Client({ connectionString: E2E_DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query(`SELECT d.status, m.kind, m.size, m.url FROM deliveries d
      JOIN posts p ON p.delivery_id=d.id JOIN media m ON m.id=(d.payload->'media'->0->>'mediaId')::uuid
      WHERE p.content_id=$1`, [new URL(page.url()).pathname.split("/").pop()]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "scheduled", kind: "image" });
    expect(Number(rows[0].size)).toBeGreaterThan(0);
    expect(rows[0].url).toContain(".png");
  } finally { await client.end(); }
  expect(errors).toEqual([]);
  await page.evaluate(async () => { await Promise.all(document.getAnimations().map(a => a.finished.catch(() => {}))); });
  await page.screenshot({ path: testInfo.outputPath("compose-image.png"), fullPage: true });
});

import { test, expect } from "@playwright/test";
import { setFree, setPro } from "./helpers";

for (const width of [1440, 390]) {
  test(`TikTok advanced token connection at ${width}`, async ({ page, request }, testInfo) => {
    await setPro(request);
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/channels?connect=1");
    const sheet = page.getByRole("dialog");
    await expect(sheet.locator('a[href="/api/oauth/connect/tiktok"]')).toBeVisible();
    const advanced = sheet.locator("details").filter({ has: page.getByText("TikTok — Advanced: paste a token", { exact: true }) });
    await expect(advanced.getByLabel("Access token", { exact: true })).not.toBeVisible();
    await advanced.locator("summary").click();
    await expect(advanced).toContainText("By default, connect through this instance's TikTok app using OAuth");
    await advanced.getByLabel("Access token", { exact: true }).fill("expired-access");
    await advanced.getByLabel("Refresh token", { exact: true }).fill("e2e-refresh");
    await advanced.getByLabel("Issuing app client key").fill("e2e-issuer-key");
    const secret = advanced.getByLabel("Issuing app client secret");
    await expect(secret).toHaveAttribute("type", "password");
    await secret.fill("invalid-secret");
    await advanced.getByRole("button", { name: "Connect TikTok" }).click();
    await expect(advanced.getByRole("alert")).toContainText("Token validation failed");
    await secret.fill("e2e-issuer-secret");
    await page.screenshot({ path: testInfo.outputPath(`token-form-${width}.png`) });
    await advanced.getByRole("button", { name: "Connect TikTok" }).click();
    await expect(sheet).not.toBeVisible();
    await expect(page.getByText("Pasted TikTok Creator", { exact: true }).first()).toBeVisible();
    const channels = await request.get("/api/v1/channels");
    const body = await channels.text();
    expect(body).toContain('"connection_mode":"manual_token"');
    expect(body).not.toContain("e2e-issuer-secret");
    await page.getByText("Pasted TikTok Creator", { exact: true }).first().click();
    await expect(page.getByRole("heading", { name: "Reconnect TikTok" })).toBeVisible();
    await expect(page.getByLabel("Issuing app client secret")).toHaveValue("");
  });
}

test("FREE shows the advanced connection license gate", async ({ page, request }) => {
  await setFree(request);
  await page.goto("/channels?connect=1");
  const advanced = page.getByRole("dialog").locator("details").filter({ hasText: "TikTok — Advanced: paste a token" });
  await advanced.locator("summary").click();
  await expect(advanced.getByRole("link", { name: "Requires a PRO license" })).toBeVisible();
  await expect(advanced.locator("form")).toHaveCount(0);
});

import { test, expect } from "@playwright/test";
import { Client } from "pg";
import { E2E_DATABASE_URL } from "./env";
import { setPro, gotoOk, watchConsole } from "./helpers";

// LinkedIn Company Pages: tile → LinkedIn consent (intercepted) → picker → one Page channel; a Page
// channel reconnects through the same flow; the picker without a parked token sends the user back.
test("LinkedIn Company Page: connect one Page through the picker, Page reconnect, picker guard", async ({ page }, testInfo) => {
  await setPro(page.request);
  const { errors } = watchConsole(page);
  const client = new Client({ connectionString: E2E_DATABASE_URL });
  await client.connect();
  let channelId = "";
  try {
    await gotoOk(page, "/channels?connect=1");
    const sheet = page.locator("#connect-sheet");
    const profile = sheet.locator(".ct-tile", { hasText: /^LinkedIn\s*Publish to your profile/ });
    const pagesTile = sheet.locator(".ct-tile", { hasText: "LinkedIn Company Page" });
    await expect(profile).toHaveAttribute("href", "/api/oauth/connect/linkedin");
    await expect(pagesTile).toHaveAttribute("href", "/api/oauth/connect/linkedin?pages=1");
    await page.screenshot({ path: testInfo.outputPath("linkedin-tiles.png"), animations: "disabled" });

    // Redirect hops are not routable, so intercept our own start request: keep its state cookie and
    // answer as if LinkedIn's consent was granted (straight back to our callback), never leaving the app.
    let authorize: URL | undefined;
    await page.route("**/api/oauth/connect/linkedin?pages=1", async (route) => {
      const start = await route.fetch({ maxRedirects: 0 });
      authorize = new URL(start.headers()["location"]!);
      const back = new URL(authorize.searchParams.get("redirect_uri")!);
      back.search = new URLSearchParams({ code: "e2e-code", state: authorize.searchParams.get("state")! }).toString();
      await route.fulfill({ response: start, headers: { ...start.headers(), location: back.href } });
    });
    await page.route("https://www.linkedin.com/**", (route) => route.abort());
    await pagesTile.click();
    await expect(page).toHaveURL(/\/channels\/pick\/linkedin$/);
    expect(authorize!.searchParams.get("scope")).toBe("openid profile w_member_social w_organization_social r_organization_admin");
    expect(authorize!.searchParams.get("redirect_uri")).toMatch(/\/api\/oauth\/connect\/linkedin\/callback$/);

    // Picker: profile unticked, both recorded Pages ticked; keep only Example Academy.
    const person = page.getByRole("checkbox", { name: /E2E LinkedIn Member/ });
    const tsa = page.getByRole("checkbox", { name: /Example Academy/ });
    const foundation = page.getByRole("checkbox", { name: /Example Foundation/ });
    await expect(person).not.toBeChecked();
    await expect(tsa).toBeChecked();
    await expect(foundation).toBeChecked();
    for (const theme of ["dark", "light"]) {
      await page.context().addCookies([{ name: "ps_theme", value: theme, url: page.url() }]);
      await page.reload();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`linkedin-picker-${theme}.png`), animations: "disabled" });
    }
    await page.context().clearCookies({ name: "ps_theme" });
    await page.getByRole("checkbox", { name: /Example Foundation/ }).uncheck();
    await page.getByRole("button", { name: "Connect selected" }).click();
    await expect(page).toHaveURL(/\/channels\?connected=linkedin&count=1$/);
    await expect(page.locator(".notice-ok")).toContainText("1 LinkedIn account(s) connected");
    const { rows: connected } = await client.query(
      "SELECT platform_id, display_name, metadata->>'subKind' AS sub_kind FROM channels WHERE platform='linkedin' AND platform_id = ANY($1) AND deleted_at IS NULL",
      [["90000002", "90000001", "e2e-li-member"]]);
    expect(connected).toEqual([{ platform_id: "90000002", display_name: "Example Academy", sub_kind: "organization" }]);
    await expect(page.getByText("Example Academy").first()).toBeVisible();

    const { rows: [ws] } = await client.query("SELECT workspace_id FROM channels WHERE platform_id='fb_e2e_1'");
    const { rows: [ch] } = await client.query(
      `INSERT INTO channels (workspace_id,platform,platform_id,display_name,token_encrypted,webhook_secret,status,connection_mode,needs_reauth_reason,metadata)
       VALUES ($1,'linkedin','e2e-org-1','E2E Company Page','unused','test','needs_reauth','oauth','token expired','{"subKind":"organization"}') RETURNING id`,
      [ws.workspace_id]);
    channelId = ch.id;
    for (const path of ["/channels", `/channels/${channelId}`]) {
      await gotoOk(page, path);
      await expect(page.locator('a[href="/api/oauth/connect/linkedin?pages=1"]').filter({ hasText: "Reconnect" }).first()).toBeVisible();
    }

    await page.goto("/channels/pick/linkedin");
    await expect(page).toHaveURL(/\/channels\?error=invalid_state$/);
    await expect(page.locator(".auth-error")).toContainText("expired or is no longer valid");
    expect(errors).toEqual([]);
  } finally {
    if (channelId) await client.query("DELETE FROM channels WHERE id=$1", [channelId]);
    await client.query("DELETE FROM channels WHERE platform='linkedin' AND platform_id = ANY($1)", [["90000002", "90000001", "e2e-li-member"]]);
    await client.end();
  }
});

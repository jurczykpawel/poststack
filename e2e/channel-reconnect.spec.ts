import { test, expect } from "@playwright/test";
import { Client } from "pg";
import { E2E_DATABASE_URL } from "./env";
import { setPro, gotoOk, watchConsole } from "./helpers";

test("publisher reconnect links agree in channels, detail and Needs attention", async ({ page }, testInfo) => {
  await setPro(page.request);
  const client = new Client({ connectionString: E2E_DATABASE_URL });
  await client.connect();
  const ids: string[] = [];
  const { errors } = watchConsole(page);
  try {
    const { rows: [workspace] } = await client.query("SELECT workspace_id FROM channels WHERE platform_id='fb_e2e_1'");
    for (const platform of ["tiktok", "linkedin", "twitter", "threads"]) {
      const { rows: [channel] } = await client.query(
        `INSERT INTO channels (workspace_id,platform,platform_id,display_name,token_encrypted,webhook_secret,status,connection_mode,needs_reauth_reason)
         VALUES ($1,$2,$3,$3,'unused','test','needs_reauth','oauth','refresh token expired') RETURNING id`,
        [workspace.workspace_id, platform, `reconnect-e2e-${platform}`],
      );
      ids.push(channel.id);
    }
    for (const path of ["/channels", "/overview", ...ids.map((id) => `/channels/${id}`)]) {
      await gotoOk(page, path);
      const platforms = path === "/channels" || path === "/overview"
        ? ["tiktok", "linkedin", "x", "threads"]
        : [["tiktok", "linkedin", "x", "threads"][ids.indexOf(path.split("/")[2])]];
      for (const slug of platforms) {
        const link = page.locator(`a[href="/api/oauth/connect/${slug}"]`).filter({ hasText: "Reconnect" });
        await expect(link.first()).toBeVisible();
      }
    }
    await page.screenshot({ path: testInfo.outputPath("publisher-reconnect.png"), animations: "disabled" });
    expect(errors).toEqual([]);
  } finally {
    await client.query("DELETE FROM channels WHERE id=ANY($1::uuid[])", [ids]);
    await client.end();
  }
});

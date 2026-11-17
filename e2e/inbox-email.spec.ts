import { test, expect } from "@playwright/test";
import { Client } from "pg";
import { E2E_DATABASE_URL } from "./env";
import { gotoOk } from "./helpers";

test("Gmail cards keep their full body in a 900px thread panel", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const db = new Client({ connectionString: E2E_DATABASE_URL });
  await db.connect();
  let channel: string | undefined;
  let contact: string | undefined;
  try {
    const ws = (await db.query("SELECT id FROM workspaces ORDER BY created_at LIMIT 1")).rows[0].id;
    channel = (await db.query(`INSERT INTO channels (workspace_id,platform,platform_id,display_name,token_encrypted,webhook_secret,status)
      VALUES ($1,'gmail','email-layout','Email layout','x','s','active') RETURNING id`, [ws])).rows[0].id;
    contact = (await db.query("INSERT INTO contacts (workspace_id,display_name) VALUES ($1,'Email layout contact') RETURNING id", [ws])).rows[0].id;
    const conv = (await db.query(`INSERT INTO conversations (workspace_id,channel_id,contact_id,platform,thread_type,status,last_message_at)
      VALUES ($1,$2,$3,'gmail','email','open',now()) RETURNING id`, [ws, channel, contact])).rows[0].id;
    for (let i = 0; i < 3; i++) {
      await db.query(`INSERT INTO messages (conversation_id,direction,text,status)
        VALUES ($1,'inbound',$2,'sent')`, [conv, `${'A complete line of email body.\n'.repeat(20)}End of email ${i}`]);
    }
    await gotoOk(page, `/inbox?open=${conv}`);
    await expect(page.locator(".email")).toHaveCount(3);
    for (const card of await page.locator(".email").all()) {
      expect(await card.evaluate(el => el.scrollHeight <= el.clientHeight)).toBe(true);
      const body = card.locator(".email-body");
      expect(await body.evaluate(el => el.getBoundingClientRect().bottom <= el.parentElement!.getBoundingClientRect().bottom)).toBe(true);
      await body.scrollIntoViewIfNeeded();
    }
    expect(await page.locator("#thread-msgs").evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    await page.getByText("End of email 2", { exact: false }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath("gmail-900px.png") });
  } finally {
    if (channel) await db.query("DELETE FROM channels WHERE id=$1", [channel]);
    if (contact) await db.query("DELETE FROM contacts WHERE id=$1", [contact]);
    await db.end();
  }
});

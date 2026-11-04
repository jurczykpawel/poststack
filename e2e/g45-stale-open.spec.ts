import { test, expect, type Page } from "@playwright/test";
import { Client } from "pg";
import { E2E_DATABASE_URL } from "./env";
import { gotoOk, setPro } from "./helpers";

// MQA19-B01: a slow answer to "open A" must not overwrite a later "open B" (Inbox, Queue, Contacts).
let db: Client;
let ws: string;
let ch: string;
const deliveries: string[] = [];
const contacts: string[] = [];
const convs: string[] = [];

test.beforeAll(async () => {
  db = new Client({ connectionString: E2E_DATABASE_URL });
  await db.connect();
  ({ rows: [{ id: ws, ch }] } = await db.query("select workspace_id as id, id as ch from channels where platform='facebook' limit 1"));
  for (const n of ["A", "B"]) {
    const { rows: [d] } = await db.query(
      "insert into deliveries(workspace_id,channel_id,format,status,payload,scheduled_at,run_at,last_error) values($1,$2,'text','failed',$3,now()-interval '1 hour',now()-interval '1 hour','boom') returning id",
      [ws, ch, { format: "text", media: [], caption: `g45 post ${n}` }]);
    deliveries.push(d.id);
    const { rows: [ct] } = await db.query("insert into contacts(workspace_id, display_name, last_interaction_at) values($1,$2,now()) returning id", [ws, `g45 contact ${n}`]);
    contacts.push(ct.id);
    await db.query("insert into contact_channels(contact_id, channel_id, platform_sender_id) values($1,$2,$3)", [ct.id, ch, `g45-${n}`]);
    const { rows: [cv] } = await db.query("insert into conversations(workspace_id, channel_id, contact_id, platform, last_message_at) values($1,$2,$3,'facebook', now() - ($4 || ' minutes')::interval) returning id", [ws, ch, ct.id, n === "A" ? "1" : "2"]);
    convs.push(cv.id);
    await db.query("insert into messages(conversation_id, direction, platform_message_id, text) values($1,'inbound',$2,$3)", [cv.id, `g45-${n}`, `g45 message ${n}`]);
  }
});

test.afterAll(async () => {
  await db.query("delete from deliveries where id = any($1)", [deliveries]);
  await db.query("delete from contacts where id = any($1)", [contacts]);
  await db.end();
});

const wired = (page: Page, sel: string) => page.waitForFunction((s) => { const l = document.querySelectorAll(s); return l.length > 0 && [...l].every((a) => "htmx-internal-data" in a); }, sel);

for (const [name, path, delayed] of [["Queue", "/queue?status=attention", "open="], ["Contacts", "/contacts?q=g45", "open="]] as const) {
  test(`${name}: a slow panel for A does not replace the panel for B`, async ({ page }) => {
    await setPro(page.request);
    const id = (i: number) => (name === "Queue" ? deliveries : contacts)[i];
    await page.route((u) => u.search.includes(`${delayed}${id(0)}`), async (route) => { await new Promise((r) => setTimeout(r, 2500)); await route.continue().catch(() => {}); });
    await gotoOk(page, path);
    await wired(page, "#data-list a.dl-rowlink");
    await page.locator(`[data-row="${id(0)}"] a.dl-rowlink`).click();
    await page.locator(`[data-row="${id(1)}"] a.dl-rowlink`).click();
    await expect(page.locator(`[data-row="${id(1)}"]`)).toHaveAttribute("aria-current", "true");
    await page.waitForTimeout(3500);
    await expect(page.locator(`[data-row="${id(1)}"]`)).toHaveAttribute("aria-current", "true");
    expect(page.url()).toContain(`open=${id(1)}`);
  });
}

test("Inbox: a slow thread for A does not replace the thread for B", async ({ page }) => {
  await setPro(page.request);
  await page.route((u) => u.pathname === `/inbox/${convs[0]}`, async (route) => { await new Promise((r) => setTimeout(r, 2500)); await route.continue().catch(() => {}); });
  await gotoOk(page, "/inbox");
  await wired(page, ".conv-item");
  await page.locator(".conv-item", { hasText: "g45 contact A" }).click();
  await page.locator(".conv-item", { hasText: "g45 contact B" }).click();
  await expect(page.locator("#thread")).toContainText("g45 message B");
  await page.waitForTimeout(3500);
  await expect(page.locator("#thread")).toContainText("g45 message B");
  await expect(page.locator("#thread")).not.toContainText("g45 message A");
});

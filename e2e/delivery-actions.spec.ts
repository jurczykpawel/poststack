import { test, expect } from "@playwright/test";
import { Client } from "pg";
import { E2E_DATABASE_URL } from "./env";
import { watchConsole } from "./helpers";

test("Queue publishes now and cancels with matching editorial API state", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const { errors } = watchConsole(page);
  const client = new Client({ connectionString: E2E_DATABASE_URL });
  await client.connect();
  let contentId = "";
  const ids: string[] = [];
  try {
    const { rows: [ws] } = await client.query("select id from workspaces order by created_at limit 1");
    const { rows: [ch] } = await client.query("select id,platform from channels where workspace_id=$1 and platform='facebook' limit 1", [ws.id]);
    const { rows: [content] } = await client.query("insert into content(workspace_id,title) values($1,'Queue actions') returning id", [ws.id]);
    contentId = content.id;
    for (const status of ["scheduled", "held"]) {
      const { rows: [d] } = await client.query("insert into deliveries(workspace_id,channel_id,format,status,payload,scheduled_at,run_at) values($1,$2,'text',$3,$4,now()+interval '1 hour',now()+interval '1 hour') returning id", [ws.id, ch.id, status, { format: "text", media: [], caption: "Queue actions" }]);
      ids.push(d.id);
      await client.query("insert into posts(workspace_id,content_id,delivery_id,platform,status,scheduled_date) values($1,$2,$3,$4,'scheduled',now()+interval '1 hour')", [ws.id, contentId, d.id, ch.platform]);
      await client.query("select graphile_worker.add_job('publish',$1,job_key=>$2,run_at=>now()+interval '1 hour')", [JSON.stringify({ postId: d.id }), `publish:${d.id}`]);
    }
    await page.goto("/queue");
    const first = page.locator(`#post-row-${ids[0]}`);
    await first.getByRole("button", { name: "Publish now", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Publish now", exact: true }).click();
    await expect.poll(async () => (await client.query("select scheduled_at<=now() as due from deliveries where id=$1", [ids[0]])).rows[0].due).toBe(true);
    expect((await client.query("select count(*)::int as n from graphile_worker.jobs where key=$1", [`publish:${ids[0]}`])).rows[0].n).toBe(1);
    const before = await (await page.request.get(`/api/v1/content/${contentId}`)).json();
    expect(before.data.posts.find((p: { deliveryId: string }) => p.deliveryId === ids[1]).delivery.status).toBe("held");
    const second = page.locator(`#post-row-${ids[1]}`);
    await second.getByRole("button", { name: "Cancel post", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Cancel post", exact: true }).click();
    await expect.poll(async () => (await client.query("select status from deliveries where id=$1", [ids[1]])).rows[0].status).toBe("canceled");
    const after = await (await page.request.get(`/api/v1/content/${contentId}`)).json();
    const canceled = after.data.posts.find((p: { deliveryId: string | null }) => p.deliveryId === null);
    expect(canceled).toMatchObject({ status: "planned", deliveryId: null, delivery: null });
    expect((await (await page.request.get(`/api/v1/posts/${canceled.id}`)).json()).data).toMatchObject({ status: "planned", deliveryId: null, delivery: null });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("queue-actions-390.png"), fullPage: true });
    expect(errors).toEqual([]);
  } finally {
    if (contentId) {
      await client.query("delete from posts where content_id=$1", [contentId]);
      await client.query("delete from content where id=$1", [contentId]);
    }
    for (const id of ids) {
      await client.query("select graphile_worker.remove_job($1)", [`publish:${id}`]);
      await client.query("delete from deliveries where id=$1", [id]);
    }
    await client.end();
  }
});

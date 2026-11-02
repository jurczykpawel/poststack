import { test, expect } from "@playwright/test";
import { Client } from "pg";
import { E2E_DATABASE_URL } from "./env";
import { gotoOk, setPro, watchConsole } from "./helpers";

// Overview must agree with Queue: failed/held/unknown Queue posts count in the KPI cards and
// show up under "Needs attention", with labels that say posts vs replies.
const PREFIX = "ovatt";
let db: Client;
let workspaceId: string;
let channelId: string;

test.beforeAll(async () => {
  db = new Client({ connectionString: E2E_DATABASE_URL });
  await db.connect();
  const { rows: [ch] } = await db.query<{ id: string; workspace_id: string }>("SELECT id, workspace_id FROM channels WHERE platform = 'facebook' LIMIT 1");
  workspaceId = ch!.workspace_id;
  channelId = ch!.id;
  for (const [status, err] of [["failed", "Token expired"], ["failed", "Provider 500"], ["held", "Rate limit"], ["unknown", "No confirmation"]] as const) {
    await db.query(
      `INSERT INTO deliveries (workspace_id, channel_id, format, status, payload, scheduled_at, run_at, last_error)
       VALUES ($1, $2, 'text', $3, $4, now() - interval '9 days', now() - interval '9 days', $5)`,
      [workspaceId, channelId, status, { format: "text", media: [], caption: `${PREFIX} ${status}` }, err],
    );
  }
});

test.afterAll(async () => {
  await db.query("DELETE FROM deliveries WHERE workspace_id = $1 AND payload->>'caption' LIKE $2", [workspaceId, `${PREFIX} %`]);
  await db.end();
});

test("Overview counts failed/held Queue posts and links to Queue attention", async ({ page, request }) => {
  await setPro(request);
  const { errors } = watchConsole(page);
  await gotoOk(page, "/overview");
  const failed = page.locator("a.kpi", { hasText: "Failed" });
  await expect(failed).toContainText("2 posts");
  await expect(failed).toContainText("replies");
  await expect(failed).toHaveAttribute("href", "/queue?status=attention");
  await expect(page.locator("a.kpi", { hasText: "Held" })).toContainText("1 posts unknown");
  // Old (9 days) attention posts still appear; the panel is not "All healthy".
  await expect(page.getByText("All healthy")).toHaveCount(0);
  await expect(page.locator(".attn-row")).toHaveCount(4);
  await expect(page.getByRole("link", { name: /All posts in Queue/ })).toHaveAttribute("href", "/queue?status=attention");
  expect(errors).toEqual([]);
});

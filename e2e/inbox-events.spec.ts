import { test, expect } from "@playwright/test";
import { Client } from "pg";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { E2E_DATABASE_URL, serverEnv } from "./env";
import { gotoOk, setPro, watchConsole } from "./helpers";
import inbound from "../tests/fixtures/inbox/inbound.json";

test("outgoing subscriptions offer contact erasure and conversation updates", async ({ page }) => {
  await setPro(page.request);
  const { errors } = watchConsole(page);
  const url = "https://example.test/inbox-events";
  let endpointId: string | undefined;
  try {
    await gotoOk(page, "/webhooks#outgoing");
    await page.getByRole("button", { name: "Outgoing alert", exact: true }).click();
    await page.getByText("Add an endpoint", { exact: true }).click();
    const form = page.locator('form[hx-post="/webhooks/outbound"]');
    await form.locator('[name="url"]').fill(url);
    await form.getByRole("checkbox", { name: "contact.erased", exact: true }).check();
    await form.getByRole("checkbox", { name: "conversation.updated", exact: true }).check();
    await form.getByRole("button", { name: "Add endpoint" }).click();
    await expect(page.locator("#wh-outbound .notice")).toContainText("Endpoint added");
    const response = await page.request.get("/api/v1/webhooks");
    const ep = (await response.json()).data.find((e: { url: string }) => e.url === url);
    endpointId = ep?.id;
    expect(ep.event_types).toEqual(["contact.erased", "conversation.updated"]);
    expect(errors).toEqual([]);
  } finally {
    if (endpointId) expect((await page.request.delete(`/api/v1/webhooks/${endpointId}`)).status()).toBe(204);
  }
});

test("Inbox controls emit transitions with the same state displayed to the operator", async ({ page }, testInfo) => {
  await setPro(page.request);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const { errors } = watchConsole(page);
  const client = new Client({ connectionString: E2E_DATABASE_URL });
  await client.connect();
  let channelId: string | undefined;
  let contactId: string | undefined;
  let workspaceId: string | undefined;
  let conversationId: string | undefined;
  try {
    workspaceId = (await client.query("SELECT id FROM workspaces ORDER BY created_at LIMIT 1")).rows[0].id;
    channelId = (await client.query("INSERT INTO channels (workspace_id, platform, platform_id, token_encrypted, webhook_secret) VALUES ($1, 'instagram', 'inbox-events', 'x', 's') RETURNING id", [workspaceId])).rows[0].id;
    contactId = (await client.query("INSERT INTO contacts (workspace_id, display_name) VALUES ($1, 'Inbox event contact') RETURNING id", [workspaceId])).rows[0].id;
    conversationId = (await client.query("INSERT INTO conversations (workspace_id, channel_id, contact_id, platform) VALUES ($1, $2, $3, 'instagram') RETURNING id", [workspaceId, channelId, contactId])).rows[0].id;
    await gotoOk(page, `/inbox?open=${conversationId}`);
    await page.locator(".th-actions").getByRole("button", { name: "Done", exact: true }).click();
    await expect(page.getByRole("button", { name: "Reopen", exact: true })).toBeVisible();
    await expect(page.locator("#thread")).not.toHaveClass(/htmx-settling/);
    await page.getByRole("button", { name: "Reopen", exact: true }).click();
    await expect(page.locator(".th-actions").getByRole("button", { name: "Done", exact: true })).toBeVisible();
    await expect(page.locator("#thread")).not.toHaveClass(/htmx-settling/);
    await page.locator(".pause-row input").uncheck();
    await expect(page.locator(".pause-row")).toContainText("Auto-replies paused");
    await expect(page.locator("#thread")).not.toHaveClass(/htmx-settling/);
    await page.locator(".pause-row input").check();
    await expect(page.locator(".pause-row")).toContainText("Auto-replies on");
    const rows = await client.query("SELECT payload FROM events WHERE workspace_id = $1 AND subject_id = $2 AND type = 'conversation.updated' ORDER BY created_at", [workspaceId, conversationId]);
    expect(rows.rows.map((e) => [e.payload.previous.status, e.payload.current.status, e.payload.previous.is_automation_paused, e.payload.current.is_automation_paused])).toEqual([
      ["open", "closed", false, false], ["closed", "open", false, false], ["open", "open", false, true], ["open", "open", true, false],
    ]);
    for (const row of rows.rows) expect(row.payload).toMatchObject({ conversationId, contactId, channelId, workspaceId });
    await expect(page.locator("#thread")).not.toHaveClass(/htmx-settling/);
    await page.locator(".th-actions").getByRole("button", { name: "Done", exact: true }).click();
    await expect(page.getByRole("button", { name: "Reopen", exact: true })).toBeVisible();
    await client.query("UPDATE channels SET status = 'paused' WHERE id = $1", [channelId]);
    await client.query("INSERT INTO contact_channels (contact_id, channel_id, platform_sender_id) VALUES ($1, $2, 'inbox-event-sender')", [contactId, channelId]);
    const job = { platform: "instagram", pageId: "inbox-events", senderId: "inbox-event-sender", recipientId: "inbox-events",
      mid: inbound.rows[0].platform_message_id, text: inbound.rows[0].text, timestamp: Date.parse(inbound.rows[0].created_at) / 1000 };
    await promisify(execFile)("bun", ["--no-env-file", "-e", `
      const { processIncomingMessage } = await import('./src/lib/workers/incoming-message-worker.ts');
      const helpers = { logger: { info() {} }, job: { attempts: 1, max_attempts: 3 } };
      await processIncomingMessage(${JSON.stringify(job)}, helpers);
      await processIncomingMessage(${JSON.stringify(job)}, helpers);
      const { closeQueue } = await import('./src/lib/queue/client.ts');
      const { db } = await import('./src/lib/db.ts');
      await closeQueue();
      await db.$client.end();
    `], { env: serverEnv(), timeout: 15_000 });
    await gotoOk(page, `/inbox?open=${conversationId}`);
    await expect(page.locator(".th-actions").getByRole("button", { name: "Done", exact: true })).toBeVisible();
    await expect(page.locator("#thread")).toContainText(inbound.rows[0].text);
    const afterInbound = await client.query("SELECT payload FROM events WHERE workspace_id = $1 AND subject_id = $2 AND type = 'conversation.updated' ORDER BY created_at", [workspaceId, conversationId]);
    expect(afterInbound.rows).toHaveLength(6);
    expect(afterInbound.rows[5].payload).toMatchObject({ conversationId, contactId, channelId, workspaceId, previous: { status: "closed" }, current: { status: "open" } });
    await page.screenshot({ path: testInfo.outputPath("inbox-events.png") });
    expect(errors).toEqual([]);
  } finally {
    if (conversationId) await client.query("DELETE FROM events WHERE workspace_id = $1 AND subject_id = $2", [workspaceId, conversationId]);
    if (channelId) await client.query("DELETE FROM channels WHERE id = $1", [channelId]);
    if (contactId) await client.query("DELETE FROM contacts WHERE id = $1", [contactId]);
    await client.end();
  }
});

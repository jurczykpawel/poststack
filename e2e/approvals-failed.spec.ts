import { expect, test } from "@playwright/test";
import { Client } from "pg";
import { E2E_DATABASE_URL } from "./env";
import { gotoOk } from "./helpers";

test("failed approval is visible across Inbox and Overview and can be retried from Approvals", async ({ page }) => {
  const db = new Client({ connectionString: E2E_DATABASE_URL });
  await db.connect();
  let contactId: string | undefined;
  let approvalId: string | undefined;
  try {
    const { rows: [channel] } = await db.query("SELECT id, workspace_id FROM channels WHERE platform = 'facebook' LIMIT 1");
    const { rows: [contact] } = await db.query(
      "INSERT INTO contacts (workspace_id, display_name) VALUES ($1, 'Approval retry contact') RETURNING id", [channel.workspace_id],
    );
    contactId = contact.id;
    const { rows: [conversation] } = await db.query(
      `INSERT INTO conversations (workspace_id, channel_id, contact_id, platform, last_message_at, last_inbound_at)
       VALUES ($1, $2, $3, 'facebook', now(), now()) RETURNING id`, [channel.workspace_id, channel.id, contactId],
    );
    const content = { text: "Reply awaiting review" };
    const { rows: [approval] } = await db.query(
      `INSERT INTO pending_approvals (workspace_id, channel_id, contact_id, conversation_id, recipient_platform_id, source, proposed_content)
       VALUES ($1, $2, $3, $4, 'retry-recipient', 'ai_auto', $5) RETURNING id`, [channel.workspace_id, channel.id, contactId, conversation.id, { content }],
    );
    approvalId = approval.id;
    await gotoOk(page, `/inbox?open=${conversation.id}`);
    const draft = page.locator(`[data-approval-id="${approvalId}"]`);
    await draft.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(draft.getByRole("textbox", { name: "Reply text" })).toHaveAttribute("maxlength", "2000");

    await gotoOk(page, "/approvals");
    const card = page.locator(".appr", { hasText: content.text });
    await card.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(card.getByRole("textbox", { name: "Reply text" })).toHaveAttribute("maxlength", "2000");
    await card.getByRole("button", { name: "Cancel", exact: true }).click();
    await card.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(card).toHaveCount(0);

    // The E2E web fixture runs without a worker. Seed its terminal outcome here.
    await gotoOk(page, "/overview");
    const failed = page.locator(".kpi").filter({ has: page.locator(".kpi-l", { hasText: /^Failed$/ }) }).locator(".kpi-n");
    const before = Number(await failed.textContent());
    const { rows: [message] } = await db.query(
      `INSERT INTO messages (conversation_id, direction, text, status, failure_reason)
       VALUES ($1, 'outbound', $2, 'failed', 'Provider unavailable') RETURNING id`, [conversation.id, content.text],
    );
    const key = `approval:${approvalId}`;
    await db.query(
      `INSERT INTO outbound_deliveries (delivery_key, workspace_id, channel_id, contact_id, task_name, status, payload)
       SELECT $1, $2, $3, $4, 'outgoing-message', 'failed', payload::jsonb || jsonb_build_object('failedMessageId', $5::text)
       FROM graphile_worker._private_jobs WHERE key = $6`, [key, channel.workspace_id, channel.id, contactId, message.id, `approval-${approvalId}`],
    );
    await gotoOk(page, "/overview");
    await expect(failed).toHaveText(String(before + 1));
    await gotoOk(page, `/inbox?open=${conversation.id}`);
    await expect(page.locator(".msg-failed")).toHaveText("Not delivered — Provider unavailable");

    await gotoOk(page, "/approvals");
    await page.getByText(/Recently resolved/).click();
    const history = page.locator(".appr-resolved-row", { hasText: content.text });
    await expect(history.locator(".badge")).toHaveText("Failed");
    const retry = page.waitForResponse(response => response.url().endsWith(`/approvals/${approvalId}/retry`));
    await history.getByRole("button", { name: "Retry", exact: true }).click();
    expect((await retry).ok()).toBe(true);
    await expect(history.locator(".badge")).toHaveText("Queued");
    const { rows } = await db.query("SELECT payload->>'heldMessageId' AS message_id FROM graphile_worker._private_jobs WHERE key = $1", [`retry:${key}`]);
    expect(rows).toEqual([{ message_id: message.id }]);
  } finally {
    if (approvalId) {
      for (const key of [`approval-${approvalId}`, `retry:approval:${approvalId}`]) {
        await db.query("SELECT graphile_worker.remove_job($1)", [key]);
      }
    }
    if (contactId) await db.query("DELETE FROM contacts WHERE id = $1", [contactId]);
    await db.end();
  }
});

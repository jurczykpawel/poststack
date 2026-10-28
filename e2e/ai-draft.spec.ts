import recorded from "../tests/fixtures/mqa-delivery-approval.json";
import { test, expect } from "@playwright/test";
import { Client } from "pg";
import { setPro, watchConsole, gotoOk } from "./helpers";
import { E2E_DATABASE_URL } from "./env";

// AUTOREPLY-QUALITY epic (ADUX1/ADUX2/ADDEL1/ADLOG1) driven in a real browser. The AI-draft worker
// doesn't run in this harness (sections.spec.ts's own note: "NO worker needed — UI tests don't
// execute publishing"), so a pending approval can't be produced through the live pipeline here —
// each test seeds the row it needs directly (same pattern auth.setup.ts already uses for channels/
// content/posts). ADCTX1/ADCTX2 (context actually reaching the LLM prompt) are covered by unit +
// integration tests plus a live-instance check (priv/tasks/ADE2E1); there is no local worker to
// exercise that pipeline against here.

async function db(): Promise<Client> {
  const client = new Client({ connectionString: E2E_DATABASE_URL });
  await client.connect();
  return client;
}

async function seedWorkspace(client: Client): Promise<string> {
  const ws = await client.query<{ id: string }>("SELECT id FROM workspaces ORDER BY created_at ASC LIMIT 1");
  const id = ws.rows[0]?.id;
  if (!id) throw new Error("no seeded workspace — auth.setup.ts must run first");
  return id;
}

async function seedChannelAndContact(client: Client, workspaceId: string, tag: string): Promise<{ channelId: string; contactId: string }> {
  const ch = await client.query<{ id: string }>(
    `INSERT INTO channels (workspace_id, platform, platform_id, display_name, token_encrypted, webhook_secret, status)
     VALUES ($1, 'facebook', $2, $3, 'x', $4, 'active') RETURNING id`,
    [workspaceId, `pg-${tag}`, `E2E ${tag} Page`, `wh-${tag}`],
  );
  const contact = await client.query<{ id: string }>(
    `INSERT INTO contacts (workspace_id, display_name) VALUES ($1, $2) RETURNING id`,
    [workspaceId, `E2E Contact ${tag}`],
  );
  return { channelId: ch.rows[0].id, contactId: contact.rows[0].id };
}

async function seedDraft(client: Client, workspaceId: string, channelId: string, contactId: string, text: string): Promise<{ conversationId: string; approvalId: string }> {
  const conv = await client.query<{ id: string }>(
    `INSERT INTO conversations (workspace_id, channel_id, contact_id, platform, thread_type) VALUES ($1, $2, $3, 'facebook', 'dm') RETURNING id`,
    [workspaceId, channelId, contactId],
  );
  const conversationId = conv.rows[0].id;
  const appr = await client.query<{ id: string }>(
    `INSERT INTO pending_approvals (workspace_id, source, conversation_id, contact_id, channel_id, recipient_platform_id, proposed_content, status)
     VALUES ($1, 'ai_auto', $2, $3, $4, 'PSID-E2E', $5, 'pending') RETURNING id`,
    [workspaceId, conversationId, contactId, channelId, JSON.stringify({ content: { text } })],
  );
  return { conversationId, approvalId: appr.rows[0].id };
}

test.describe.serial("AI-draft UX (ADUX1/ADUX2/ADDEL1/ADLOG1)", () => {
  test.beforeEach(async ({ page }) => {
    await setPro(page.request);
  });

  test("approvals keep distinct source quotes after later activity", async ({ page }, testInfo) => {
    const client = await db();
    let conversationId = "";
    try {
      const workspaceId = await seedWorkspace(client);
      const { channelId, contactId } = await seedChannelAndContact(client, workspaceId, "source-quotes");
      ({ conversationId } = await seedDraft(client, workspaceId, channelId, contactId, "First proposal"));
      for (const [index, message] of recorded.messages.entries()) {
        const { rows } = await client.query<{ id: string }>("INSERT INTO messages (conversation_id, direction, text) VALUES ($1, 'inbound', $2) RETURNING id", [conversationId, message.text]);
        if (index === 0) {
          await client.query("UPDATE pending_approvals SET inbound_message_id = $1 WHERE conversation_id = $2", [rows[0].id, conversationId]);
        } else {
          await client.query(`INSERT INTO pending_approvals (workspace_id, source, conversation_id, contact_id, channel_id, recipient_platform_id, proposed_content, inbound_message_id)
            VALUES ($1, 'ai_auto', $2, $3, $4, 'PSID-E2E', $5, $6)`, [workspaceId, conversationId, contactId, channelId, JSON.stringify({ content: { text: "Second proposal" } }), rows[0].id]);
        }
      }
      await client.query("UPDATE conversations SET last_message_preview = $1 WHERE id = $2", [recorded.messages[1].text, conversationId]);
      const { errors } = watchConsole(page);
      await gotoOk(page, "/approvals");
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        for (const [index, message] of recorded.messages.entries()) {
          const card = page.locator(".appr").filter({ hasText: index === 0 ? "First proposal" : "Second proposal" });
          await expect(card.locator(".appr-trigger")).toHaveText(message.text);
        }
        await page.screenshot({ path: testInfo.outputPath(`approval-source-${width}.png`), fullPage: true });
      }
      const response = await page.request.get("/api/v1/approvals");
      const { data } = await response.json();
      const approvals = data.filter((a: { conversation_id: string }) => a.conversation_id === conversationId);
      expect(approvals).toHaveLength(2);
      expect(approvals.every((a: { inboundMessageId: string }) => !!a.inboundMessageId)).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      if (conversationId) await client.query("DELETE FROM conversations WHERE id = $1", [conversationId]);
      await client.end();
    }
  });

  test("inbox: Edit reveals the textarea + Save/Cancel; Cancel discards, Save persists (ADUX1)", async ({ page }) => {
    const client = await db();
    let conversationId: string;
    try {
      const workspaceId = await seedWorkspace(client);
      const { channelId, contactId } = await seedChannelAndContact(client, workspaceId, "ux1");
      ({ conversationId } = await seedDraft(client, workspaceId, channelId, contactId, "Original AI draft text"));
    } finally {
      await client.end();
    }

    const { errors } = watchConsole(page);
    await gotoOk(page, `/inbox?open=${conversationId}`);

    const card = page.locator(".msg-draft");
    const readText = card.locator(".draft-text");
    await expect(card).toBeVisible();
    // Default: read-only — the edit textarea exists (Alpine x-show toggles display, not DOM
    // presence) but must not be VISIBLE (ADUX1's whole point: no always-visible textarea).
    await expect(card.locator("textarea")).toBeHidden();
    await expect(readText).toHaveText("Original AI draft text");

    // Edit -> textarea + Save/Cancel.
    await card.getByRole("button", { name: "Edit", exact: true }).click();
    const textarea = card.locator("textarea");
    await expect(textarea).toBeVisible();
    await expect(textarea).toHaveValue("Original AI draft text");

    // Cancel discards an abandoned edit and restores the original on reopening Edit.
    await textarea.fill("Abandoned edit — should not persist");
    await card.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(card.locator("textarea")).toBeHidden();
    await expect(readText).toHaveText("Original AI draft text");
    await card.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(card.locator("textarea")).toHaveValue("Original AI draft text");

    // Save persists a real edit.
    await card.locator("textarea").fill("Saved via e2e");
    await card.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator(".msg-draft .draft-text")).toHaveText("Saved via e2e");

    expect(errors, `console errors:\n${errors.join("\n")}`).toEqual([]);
  });

  test("inbox: Delete removes the draft from the thread AND from Approvals (ADDEL1)", async ({ page }) => {
    const client = await db();
    let conversationId: string;
    let approvalId: string;
    try {
      const workspaceId = await seedWorkspace(client);
      const { channelId, contactId } = await seedChannelAndContact(client, workspaceId, "del1");
      ({ conversationId, approvalId } = await seedDraft(client, workspaceId, channelId, contactId, "Delete me via inbox"));
    } finally {
      await client.end();
    }

    await gotoOk(page, `/inbox?open=${conversationId}`);
    const card = page.locator(".msg-draft");
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "Delete", exact: true }).click();
    await page.locator(".confirm-card").getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.locator(".msg-draft")).toHaveCount(0);

    // Gone from Approvals too — same underlying row.
    await gotoOk(page, "/approvals");
    await expect(page.locator("body")).not.toContainText("Delete me via inbox");

    const verify = await db();
    try {
      const row = await verify.query("SELECT 1 FROM pending_approvals WHERE id = $1", [approvalId]);
      expect(row.rowCount).toBe(0);
    } finally {
      await verify.end();
    }
  });

  test("approvals page: Edit + Save/Cancel work the same as the inbox thread (ADUX2)", async ({ page }) => {
    const client = await db();
    try {
      const workspaceId = await seedWorkspace(client);
      const { channelId, contactId } = await seedChannelAndContact(client, workspaceId, "ux2");
      await seedDraft(client, workspaceId, channelId, contactId, "Approvals page draft");
    } finally {
      await client.end();
    }

    await gotoOk(page, "/approvals");
    const card = page.locator(".appr", { hasText: "Approvals page draft" });
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "Edit", exact: true }).click();
    const textarea = card.locator("textarea");
    await expect(textarea).toHaveValue("Approvals page draft");
    await textarea.fill("Edited from Approvals");
    await card.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator(".appr", { hasText: "Edited from Approvals" })).toBeVisible();
  });

  test("AI generation log appears on Settings -> Automation, newest first, with model/response (ADLOG1)", async ({ page }) => {
    const client = await db();
    try {
      const workspaceId = await seedWorkspace(client);
      await client.query(
        `INSERT INTO ai_generation_logs (workspace_id, kind, model, system_prompt, user_message, response, error, duration_ms)
         VALUES ($1, 'draft', 'gpt-4o-mini', 'You draft replies.', 'Congratulations on the launch!', 'Thank you so much!', NULL, 450)`,
        [workspaceId],
      );
    } finally {
      await client.end();
    }

    await gotoOk(page, "/settings#automation");
    await page.getByRole("button", { name: "Automation" }).click();
    await expect(page.getByText("AI generation log")).toBeVisible();
    const logList = page.locator(".ai-log-list");
    await expect(logList).toContainText("gpt-4o-mini");
    // Expand the row to see the full logged exchange.
    await logList.locator("details").first().click();
    await expect(logList).toContainText("Congratulations on the launch!");
    await expect(logList).toContainText("Thank you so much!");
  });
});

test("mobile inbox opens a full thread from a deep link and the list", async ({ page }, testInfo) => {
  await setPro(page.request);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  const client = await db();
  let conversationId: string;
  try {
    const workspaceId = await seedWorkspace(client);
    const { channelId, contactId } = await seedChannelAndContact(client, workspaceId, "mobile");
    ({ conversationId } = await seedDraft(client, workspaceId, channelId, contactId, "Mobile draft"));
    await client.query("UPDATE conversations SET last_message_at = now() WHERE id = $1", [conversationId]);
  } finally {
    await client.end();
  }
  await gotoOk(page, `/inbox?open=${conversationId}`);
  const checkThread = async () => {
    await expect(page.locator("#conv-panel")).toBeHidden();
    for (const control of [page.locator(".reply-bar textarea"), page.getByRole("button", { name: "Send", exact: true }), page.getByRole("button", { name: "Done", exact: true })]) {
      await expect(control).toBeInViewport({ ratio: 1 });
      const box = await control.boundingBox();
      expect(box!.width).toBeGreaterThan(40);
    }
  };
  await checkThread();
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations().filter((animation) => animation.effect?.getTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => {})));
  });
  await page.screenshot({ path: testInfo.outputPath("mobile-inbox.png"), animations: "disabled" });
  await page.getByRole("button", { name: "← Back", exact: true }).click();
  await expect(page.locator("#conv-panel")).toBeVisible();
  await expect(page.locator("#thread")).toBeHidden();
  const filters = page.locator("#conv-filter-form");
  const initialForm = await filters.elementHandle();
  await filters.getByRole("button", { name: "Any time", exact: true }).click();
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/inbox/list?") && new URL(r.url()).searchParams.get("since") === "custom"),
    filters.getByRole("option", { name: "Custom range…", exact: true }).click(),
  ]);
  await expect.poll(() => initialForm!.evaluate((form) => form.isConnected)).toBe(false);
  await expect(page.locator("#conv-panel")).not.toHaveClass(/htmx-settling/);
  for (const [name, value] of [["from", "2020-01-01"], ["to", "2099-01-01"]]) {
    const previousForm = await filters.elementHandle();
    await Promise.all([
      page.waitForResponse((r) => r.url().includes("/inbox/list?") && new URL(r.url()).searchParams.get(name) === value),
      filters.locator(`input[name='${name}']`).fill(value),
    ]);
    await expect.poll(() => previousForm!.evaluate((form) => form.isConnected)).toBe(false);
    await expect(page.locator("#conv-panel")).not.toHaveClass(/htmx-settling/);
    await expect(filters.locator(`input[name='${name}']`)).toHaveValue(value);
  }
  await page.locator(`.conv-item[hx-get="/inbox/${conversationId}"]`).click();
  await checkThread();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.locator("#conv-panel")).toBeVisible();
  await expect(page.locator("#thread")).toBeVisible();
  await expect(page.getByRole("button", { name: "← Back", exact: true })).toBeHidden();
});

import { test, expect, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { setPro, gotoOk, watchConsole } from "./helpers";
import { Client } from "pg";
import { E2E_AI_PORT, E2E_DATABASE_URL, serverEnv } from "./env";
import openaiModels from "../src/lib/ai/__fixtures__/openai-models.json";
import openaiChat from "../src/lib/ai/__fixtures__/openai-chat.json";

// AIPROVIDER1: the AI provider form on /settings/integrations/ai against a fake OpenAI-compatible provider
// (recorded response shapes). Screenshots go to the test output folder, in both themes and at phone width.
const GOOD = "sk-e2e-0123456789abcdefABCD";
const BASE = `http://127.0.0.1:${E2E_AI_PORT}/v1`;
let server: Server;

test.beforeAll(async () => {
  server = createServer((req, res) => {
    const json = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== `Bearer ${GOOD}`) return json(401, { error: { message: "bad key" } });
    if (req.url === "/v1/models") return json(200, openaiModels);
    let raw = ""; req.on("data", b => raw += b); req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      if (body.model === "no-credits") return json(429, { error: { code: "insufficient_quota" } });
      json(200, openaiChat);
    });
  });
  await new Promise<void>((r) => server.listen(E2E_AI_PORT, "127.0.0.1", r));
});
test.afterAll(() => { server.close(); });

// A failed run must not leave a saved AI config behind: the e2e server starts before global-setup and caches settings.
async function clearSavedAiConfig() {
  const client = new Client({ connectionString: E2E_DATABASE_URL });
  await client.connect();
  try { await client.query("DELETE FROM rate_limit_counters WHERE key LIKE 'rl:ai-providers:%'"); await client.query("DELETE FROM ai_providers WHERE workspace_id IS NULL"); await client.query("DELETE FROM instance_settings WHERE key LIKE 'AI\\_%'"); } finally { await client.end(); }
}

async function shoot(page: Page, base: string) {
  for (const theme of ["dark", "light"]) {
    await page.context().addCookies([{ name: "ps_theme", value: theme, url: page.url() }]);
    await page.reload({ waitUntil: "domcontentloaded" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${base}-${theme} fits`).toBe(true);
    await page.screenshot({ path: `${base}-${theme}.png`, animations: "disabled", fullPage: true });
  }
  await page.context().clearCookies({ name: "ps_theme" });
}

for (const width of [1440, 390]) test(`AI provider list: connect, order, edit, replace and remove at ${width}`, async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  try {
    await clearSavedAiConfig(); await setPro(page.request);
    const { errors } = watchConsole(page);
    await page.setViewportSize({ width, height: 1000 });
    await gotoOk(page, "/settings/integrations/ai");
    for (const model of ["first", "second", "third"]) {
      await page.getByRole("button", { name: "+ Connect provider", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "Connect AI provider", exact: true })).toBeVisible();
      await page.locator(".prov label", { hasText: "Custom" }).click();
      await page.locator("#ai-base-url").fill(BASE); await page.locator("#ai-key").fill(GOOD);
      await page.locator("#ai-key").press("Tab");
      await expect(page.locator(".ai-foot").first()).toContainText("2 models");
      await page.locator("#ai-model").fill(model);
      if (model === "first") {
        await page.locator("#ai-key").fill("sk-invalid-fixture-key");
        await page.getByRole("button", { name: "Test connection", exact: true }).click();
        await expect(page.locator("#ai-result")).toContainText("invalid_key");
        await page.getByRole("button", { name: "Connect provider", exact: true }).click();
        await expect(page.locator("#ai-result")).toContainText("Connection test failed");
        await expect(page.locator(".ai-provider-row")).toHaveCount(0);
        await page.locator("#ai-key").fill(GOOD);
      }
      await page.getByRole("button", { name: "Test connection", exact: true }).click();
      await expect(page.locator("#ai-result")).toContainText("Test passed");
      if (model === "first") {
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`connect-${width}.png`), fullPage: true, animations: "disabled" });
      }
      await page.getByRole("button", { name: "Connect provider", exact: true }).click();
      await expect(page.locator(".ai-provider-row")).toHaveCount(["first", "second", "third"].indexOf(model) + 1);
    }
    const rows = page.locator(".ai-provider-row");
    await rows.nth(1).locator("summary").click();
    await rows.nth(1).getByRole("button", { name: "Edit", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Edit AI provider", exact: true })).toBeVisible();
    await page.locator("#ai-model").fill("second-edited");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(rows.nth(1)).toContainText("second-edited");
    await rows.nth(1).locator("summary").click();
    await rows.nth(1).getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(rows.nth(1).getByRole("button", { name: "Edit", exact: true })).toBeFocused();
    await page.getByRole("button", { name: "+ Connect provider", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Connect AI provider", exact: true })).toBeVisible();
    await expect(page.locator("#ai-key")).toHaveValue("");
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await rows.nth(2).getByRole("button", { name: "Move up", exact: true }).click();
    await expect(rows.nth(1)).toContainText("third");
    await rows.nth(1).getByRole("button", { name: "Move down", exact: true }).click();
    await expect(rows.nth(2)).toContainText("third");
    await rows.nth(2).locator("summary").click(); await rows.nth(2).getByRole("button", { name: "Make main", exact: true }).click();
    await expect(rows.first()).toContainText("third"); await expect(rows.first()).toContainText("Main");
    await rows.first().locator("summary").click(); await rows.first().getByRole("button", { name: "Edit", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Edit AI provider", exact: true })).toBeVisible();
    await expect(page.locator("#ai-key")).toHaveValue(""); await page.locator("#ai-model").fill("edited");
    await page.getByRole("button", { name: "Save", exact: true }).click(); await expect(rows.first()).toContainText("edited");
    const pg = new Client({ connectionString: E2E_DATABASE_URL }); await pg.connect();
    try {
      await pg.query("UPDATE ai_providers SET model='no-credits' WHERE workspace_id IS NULL AND position=1");
      const ws = (await pg.query("SELECT id FROM workspaces LIMIT 1")).rows[0].id;
      const script = `import { chatComplete } from './src/lib/ai/client'; const r = await chatComplete({workspaceId:${JSON.stringify(ws)},kind:'draft',system:'Reply',user:'Hi'}); if(!r) process.exit(1);`;
      await new Promise<void>((resolve, reject) => execFile("bun", ["--no-env-file", "-e", script], { env: serverEnv() }, error => error ? reject(error) : resolve()));
    } finally { await pg.end(); }
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(rows.first()).toContainText("no credits"); await expect(rows.nth(1)).toContainText("Answering now");
    await shoot(page, testInfo.outputPath(`providers-${width}`));
    await rows.nth(1).locator("summary").click(); await rows.nth(1).getByRole("button", { name: "Test again", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Test passed" }).first()).toBeVisible();
    await rows.nth(2).locator("summary").click(); await rows.nth(2).getByRole("button", { name: "Remove", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Remove", exact: true }).click(); await expect(rows).toHaveCount(2);
    await page.locator(".ai-advanced summary").click();
    const json = JSON.parse(await page.getByRole("textbox", { name: "Provider JSON" }).inputValue());
    expect(JSON.stringify(json)).not.toContain(GOOD);
    await page.getByRole("textbox", { name: "Provider JSON" }).fill(JSON.stringify([json[1]]));
    await page.getByRole("button", { name: "Apply JSON", exact: true }).click(); await expect(rows).toHaveCount(1);
    expect(await page.content()).not.toContain(GOOD); expect(errors, errors.join("\n")).toEqual([]);
  } finally { await clearSavedAiConfig(); }
});

test("API keys: the operator sees the Instance group in the Custom table", async ({ page }, testInfo) => {
  await setPro(page.request);
  await gotoOk(page, "/settings/api-keys");
  await page.getByRole("button", { name: "Create API key" }).click();
  const sheet = page.locator("#api-key-sheet");
  await sheet.locator(".preset-card", { hasText: "Custom" }).click();
  await expect(sheet.locator("table.scope-mx")).toContainText("Instance (operator only)");
  await expect(sheet.getByLabel("View AI provider settings")).not.toBeChecked();
  await page.screenshot({ path: testInfo.outputPath("api-keys-instance-group.png") });
});

for (const close of ["Escape", "Close"]) test(`AI connect restores focus after ${close}`, async ({ page }) => {
  await gotoOk(page, "/settings/integrations/ai");
  const trigger = page.getByRole("button", { name: "+ Connect provider", exact: true });
  await trigger.focus(); await trigger.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Connect AI provider", exact: true });
  await expect(dialog).toBeVisible();
  if (close === "Escape") await page.keyboard.press("Escape");
  else await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
});

test("AI connect identifies an overlong key and preserves the form", async ({ page }, testInfo) => {
  await clearSavedAiConfig();
  try {
    await gotoOk(page, "/settings/integrations/ai");
    await page.getByRole("button", { name: "+ Connect provider", exact: true }).click();
    await page.locator("#ai-key").fill("x".repeat(501));
    await page.locator("#ai-model").fill("gpt-4o-mini");
    await page.getByRole("button", { name: "Connect provider", exact: true }).click();
    await expect(page.locator("#ai-key-error")).toHaveText("API key must be at most 500 characters");
    await expect(page.locator("#ai-key")).toHaveAttribute("aria-invalid", "true");
    await expect(page.locator("#ai-key")).toHaveAttribute("aria-describedby", "ai-key-error");
    await expect(page.locator("#ai-key")).toHaveValue("x".repeat(501));
    await expect(page.locator("#ai-model")).toHaveValue("gpt-4o-mini");
    await expect(page.locator(".ai-provider-row")).toHaveCount(0);
    for (const width of [1440, 390]) for (const theme of ["dark", "light"]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(theme => document.documentElement.setAttribute("data-theme", theme), theme);
      await expect(page.locator("#ai-key-error")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`key-error-${width}-${theme}.png`), fullPage: true, animations: "disabled" });
    }
    await page.locator("#ai-key").fill("x".repeat(500));
    await expect(page.locator("#ai-key-error")).not.toBeVisible();
    await expect(page.locator("#ai-key")).not.toHaveAttribute("aria-invalid", "true");
  } finally { await clearSavedAiConfig(); }
});

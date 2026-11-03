import { test, expect, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { setPro, gotoOk, watchConsole } from "./helpers";
import { Client } from "pg";
import { E2E_AI_PORT, E2E_DATABASE_URL } from "./env";
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
    req.resume().on("end", () => json(200, openaiChat));
  });
  await new Promise<void>((r) => server.listen(E2E_AI_PORT, "127.0.0.1", r));
});
test.afterAll(() => { server.close(); });

// A failed run must not leave a saved AI config behind: the e2e server starts before global-setup and caches settings.
async function clearSavedAiConfig() {
  const client = new Client({ connectionString: E2E_DATABASE_URL });
  await client.connect();
  try { await client.query("DELETE FROM instance_settings WHERE key LIKE 'AI\\_%'"); } finally { await client.end(); }
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

test("AI provider: pick, list models, test, save, reload, revert", async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  try {
  await setPro(page.request);
  const { errors } = watchConsole(page);
  await gotoOk(page, "/settings/integrations/ai");

  // Presets show their own Base URL; no key yet, so the list explains what to do.
  await expect(page.locator(".prov label")).toHaveCount(5);
  await expect(page.locator(".ai-ro code")).toHaveText("https://api.openai.com/v1");
  await expect(page.locator("#ai-models")).toContainText("Paste your key");

  // Custom provider → own Base URL; the key loads the model list (chat models only).
  await page.locator(".prov label", { hasText: "Custom" }).click();
  await page.locator("#ai-base-url").fill(BASE);
  await page.locator("#ai-key").fill(GOOD);
  await page.locator("#ai-key").press("Tab");
  await expect(page.locator(".ai-foot").first()).toContainText("2 models · 5 non-chat hidden");
  await page.locator("#ai-model").fill("");
  await page.locator("#ai-model").focus();
  await expect(page.locator(".ai-opt[data-id]:visible")).toHaveCount(2);
  await page.locator(".ai-opt[data-id='gpt-4o-mini']").click();
  await expect(page.locator("#ai-model")).toHaveValue("gpt-4o-mini");

  // A name that is not on the list can be used as is.
  await page.locator("#ai-model").fill("my-fine-tune");
  await expect(page.locator(".ai-custom")).toContainText("Use custom name: my-fine-tune");
  await page.locator("#ai-model").fill("gpt-4o-mini");

  // Tests: success, wrong key, blocked target.
  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(page.locator("#ai-result")).toContainText("Works");
  await page.locator("#ai-key").fill("sk-wrong-0123456789abcdefghij");
  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(page.locator("#ai-result")).toContainText("invalid_key");
  await page.locator("#ai-key").fill(GOOD);
  await page.locator("#ai-base-url").fill("http://127.0.0.1:9/v1");
  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(page.locator("#ai-result")).toContainText("AI_ALLOWED_PRIVATE_TARGETS");
  await page.locator("#ai-base-url").fill(BASE);

  // Save verifies first; the grid comes back with the new state.
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".notice-ok").first()).toContainText("Saved");
  await expect(page.locator(".int-detail-head .int-state")).toContainText("Set up");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator(".prov input:checked")).toHaveValue("custom");
  await expect(page.locator("#ai-base-url")).toHaveValue(BASE);
  await expect(page.locator("#ai-model")).toHaveValue("gpt-4o-mini");
  await expect(page.locator("#ai-key")).toHaveAttribute("placeholder", /set \(paste to change\)/);

  // Evidence with data in it: list open, both themes, desktop and phone.
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1100 });
    await page.locator("#ai-model").fill("");
    await page.locator("#ai-model").focus();
    await expect(page.locator(".ai-opt[data-id]:visible").first()).toBeVisible();
    await shoot(page, testInfo.outputPath(`ai-provider-${width}`));
    await page.locator("#ai-model").fill("gpt-4o-mini");
  }

  // Changing only the provider keeps nothing of the old key in the field.
  await page.locator(".prov label", { hasText: "Groq" }).click();
  await expect(page.locator("#ai-key")).toHaveValue("");
  await expect(page.locator(".ai-ro code")).toHaveText("https://api.groq.com/openai/v1");

  // Revert to environment values.
  await page.getByRole("button", { name: "Use environment values" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Use environment", exact: true }).click();
  await expect(page.locator(".notice-ok").first()).toContainText("Reverted");
  expect(errors, errors.join("\n")).toEqual([]);
  } finally {
    await clearSavedAiConfig();
  }
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

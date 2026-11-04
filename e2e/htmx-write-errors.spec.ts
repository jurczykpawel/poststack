import { test, expect, type Page } from "@playwright/test";

// MQA18-B04: a failed htmx write (offline / 5xx) must show a toast, never look saved.
async function addHtmxForm(page: Page) {
  await page.goto("/overview");
  await page.evaluate(() => {
    document.body.insertAdjacentHTML("beforeend", '<form id="t-form" hx-post="/e2e-write" hx-swap="none"><button id="t-go" type="submit">go</button></form>');
    (window as unknown as { htmx: { process(el: Element): void } }).htmx.process(document.getElementById("t-form")!);
  });
}

test("offline write shows a 'no connection' toast", async ({ page, context }) => {
  await addHtmxForm(page);
  await context.setOffline(true);
  await page.evaluate(() => (document.getElementById("t-go") as HTMLButtonElement).click());
  await expect(page.locator(".toasts")).toContainText("Not saved — no connection");
  await context.setOffline(false);
});

test("server error on a write shows a toast; one the server already explained does not double up", async ({ page }) => {
  await addHtmxForm(page);
  await page.route("**/e2e-write", (r) => r.fulfill({ status: 500, body: "boom" }));
  await page.evaluate(() => (document.getElementById("t-go") as HTMLButtonElement).click());
  await expect(page.locator(".toasts")).toContainText("Not saved — server error");
  await page.unroute("**/e2e-write");
  await page.route("**/e2e-write", (r) => r.fulfill({ status: 422, headers: { "HX-Trigger": JSON.stringify({ "ps:toast": { tone: "bad", msg: "Server said no" } }) }, body: "" }));
  await page.evaluate(() => (document.getElementById("t-go") as HTMLButtonElement).click());
  await expect(page.locator(".toasts")).toContainText("Server said no");
  await expect(page.locator(".toasts")).not.toContainText("server error");
});

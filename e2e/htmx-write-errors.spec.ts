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

test("with a modal open, only requests from the modal report inside it; other toasts stay above it", async ({ page }, testInfo) => {
  await addHtmxForm(page);
  await page.evaluate(() => {
    document.body.insertAdjacentHTML("beforeend", '<dialog id="t-modal" aria-label="Probe"><form id="t-inner" hx-post="/e2e-inner" hx-swap="none"><button id="t-inner-go" type="submit">inner</button></form></dialog>');
    const dialog = document.getElementById("t-modal") as HTMLDialogElement;
    (window as unknown as { htmx: { process(el: Element): void } }).htmx.process(dialog);
    dialog.showModal();
  });
  const trigger = (tone: string, msg: string) => ({ status: 200, headers: { "HX-Trigger": JSON.stringify({ "ps:toast": { tone, msg } }) }, body: "" });
  const submit = (id: string) => page.evaluate((target) => (document.getElementById(target) as HTMLButtonElement).click(), id);
  const feedback = page.locator("#t-modal .modal-feedback");

  await page.route("**/e2e-write", (r) => r.fulfill(trigger("warn", "Outside warning")));
  await submit("t-go");
  await expect(page.locator(".toasts")).toContainText("Outside warning");
  await expect(feedback).toHaveCount(0);

  await page.unroute("**/e2e-write");
  await page.route("**/e2e-write", (r) => r.fulfill({ status: 500, body: "boom" }));
  await submit("t-go");
  await expect(page.locator(".toasts")).toContainText("Not saved — server error");
  await expect(feedback).toHaveCount(0);

  await page.route("**/e2e-inner", (r) => r.fulfill(trigger("bad", "Inside error")));
  await submit("t-inner-go");
  await expect(feedback).toHaveText("Inside error");
  await page.unroute("**/e2e-inner");
  await page.route("**/e2e-inner", (r) => r.fulfill({ status: 500, body: "boom" }));
  await submit("t-inner-go");
  await expect(feedback).toHaveText("Not saved — server error. Try again in a moment.");

  await page.unroute("**/e2e-inner");
  await page.route("**/e2e-inner", (r) => r.fulfill(trigger("ok", "Inside saved")));
  await submit("t-inner-go");
  await expect(page.locator(".toasts")).toContainText("Inside saved");
  // The top layer is the only place painted above a modal dialog.
  await expect(page.locator(".toasts:popover-open")).toBeVisible();
  const box = (await page.locator(".toasts").boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(viewport.width - (box.x + box.width)).toBeCloseTo(16, 0);
  expect(viewport.height - (box.y + box.height)).toBeCloseTo(16, 0);
  await page.screenshot({ path: testInfo.outputPath("toast-above-modal.png"), animations: "disabled" });
});

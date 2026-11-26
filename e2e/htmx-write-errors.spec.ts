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

test("with a modal open, its requests report inside it without moving focus; other messages wait until it closes", async ({ page }, testInfo) => {
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
  const toasts = page.locator(".toasts");
  await expect(toasts).not.toHaveAttribute("popover");

  await page.route("**/e2e-write", (r) => r.fulfill(trigger("warn", "Outside warning")));
  await submit("t-go");
  await page.unroute("**/e2e-write");
  await page.route("**/e2e-write", (r) => r.fulfill({ status: 500, body: "boom" }));
  await submit("t-go");
  await page.waitForResponse("**/e2e-write");
  await expect(toasts).toHaveText("");
  await expect(feedback).toHaveCount(0);

  await page.route("**/e2e-inner", (r) => r.fulfill(trigger("bad", "Inside error")));
  await submit("t-inner-go");
  await expect(feedback).toHaveText("Inside error");
  await expect(feedback).toHaveAttribute("role", "alert");
  await page.unroute("**/e2e-inner");
  await page.route("**/e2e-inner", (r) => r.fulfill({ status: 500, body: "boom" }));
  await submit("t-inner-go");
  await expect(feedback).toHaveText("Not saved — server error. Try again in a moment.");

  await page.unroute("**/e2e-inner");
  await page.route("**/e2e-inner", (r) => r.fulfill(trigger("ok", "Inside saved")));
  await page.focus("#t-inner-go");
  await submit("t-inner-go");
  await expect(feedback).toHaveText("Inside saved");
  await expect(feedback).toHaveAttribute("role", "status");
  await expect(feedback).toHaveClass(/notice-ok/);
  await expect(page.locator("#t-inner-go")).toBeFocused();
  await expect(toasts).toHaveText("");
  await page.screenshot({ path: testInfo.outputPath("status-in-modal.png"), animations: "disabled" });

  // A modal that closes right after its save hands the confirmation to the page, with the deferred messages.
  await page.evaluate(() => (document.getElementById("t-modal") as HTMLDialogElement).close());
  await expect(feedback).toHaveCount(0);
  await expect(toasts).toContainText("Outside warning");
  await expect(toasts).toContainText("Not saved — server error");
  await expect(toasts).toContainText("Inside saved");
});

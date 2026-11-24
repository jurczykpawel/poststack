import { test, expect, type Page, type Request } from "@playwright/test";
import { gotoOk } from "./helpers";

async function holdRequest(page: Page, matches: (url: URL) => boolean) {
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await page.route(matches, async (route) => {
    const response = await route.fetch();
    held.resolve();
    await release.promise;
    await route.fulfill({ response }).catch(() => {});
  }, { times: 1 });
  return { held: held.promise, release: release.resolve };
}

function requestOutcome(page: Page, matches: (url: URL) => boolean) {
  const matching = (request: Request) => matches(new URL(request.url()));
  return Promise.race([
    page.waitForEvent("requestfailed", { predicate: matching }).then(() => "aborted"),
    page.waitForEvent("requestfinished", { predicate: matching }).then(() => "finished"),
  ]);
}

test("Inbox keeps the latest tab when an older filter request is slow", async ({ page }) => {
  await gotoOk(page, "/inbox");
  const comments = (url: URL) => url.pathname === "/inbox/list" && url.searchParams.get("filter") === "comment";
  const first = await holdRequest(page, comments);
  const outcome = requestOutcome(page, comments);
  const tabs = page.locator("#conv-filter-form");
  await expect(tabs.getByRole("button", { name: "Open", exact: true })).toHaveClass(/btn-primary/);
  try {
    await tabs.getByRole("button", { name: "Comments", exact: true }).click();
    await first.held;
    await tabs.getByRole("button", { name: "DMs", exact: true }).click();
    await expect(page).toHaveURL(/filter=dm(?:&|$)/);
  } finally { first.release(); }
  expect(await outcome).toBe("aborted");
  await expect(tabs.getByRole("button", { name: "DMs", exact: true })).toHaveClass(/btn-primary/);
  await expect(page).toHaveURL(/filter=dm(?:&|$)/);
});

test("Rules keeps the latest editor when the first rule is slow", async ({ page }) => {
  for (const name of ["Navigation rule one", "Navigation rule two"]) {
    const response = await page.request.post("/rules", {
      data: { name, trigger_type: "keyword", keywords: "navigation", response_mode: "text", text: "test reply" },
    });
    expect(response.ok()).toBe(true);
  }
  await gotoOk(page, "/rules");
  const list = page.locator("#rules-list");
  const edit = (name: string) => list.locator("tr", { hasText: name }).getByRole("button", { name: "Edit", exact: true });
  const firstEdit = edit("Navigation rule one");
  const firstPath = await firstEdit.getAttribute("hx-get");
  await page.waitForFunction((path) => {
    const button = document.querySelector(`#rules-list button[hx-get="${path}"]`);
    return !!button && "htmx-internal-data" in button;
  }, firstPath);
  const matches = (url: URL) => url.pathname === firstPath;
  const first = await holdRequest(page, matches);
  const outcome = requestOutcome(page, matches);
  try {
    await firstEdit.click();
    await first.held;
    await edit("Navigation rule two").click();
    await expect(list.locator('input[name="name"]')).toHaveValue("Navigation rule two");
  } finally { first.release(); }
  expect(await outcome).toBe("aborted");
  await expect(list.locator('input[name="name"]')).toHaveValue("Navigation rule two");
});

test("Inbox shows an unavailable conversation on mobile and keeps the list usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoOk(page, "/inbox?open=10000000-2000-4000-8000-300000000000");
  await expect(page.getByRole("alert").filter({ hasText: "Conversation not found" })).toBeVisible();
  const tabs = page.locator("#conv-filter-form");
  await expect(tabs.getByRole("button", { name: "Open", exact: true })).toHaveClass(/btn-primary/);
  await tabs.getByRole("button", { name: "DMs", exact: true }).click();
  await expect(page).toHaveURL(/filter=dm(?:&|$)/);
  await expect(page.getByRole("alert").filter({ hasText: "Conversation not found" })).toHaveCount(0);
});

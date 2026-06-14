import type { APIRequestContext, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { mintProToken } from "./fixtures/keys";

// ── License toggle (the crux) ─────────────────────────────────────────────────────────────────
// The app verifies a pasted Sellf token offline against SELLF_JWKS_FALLBACK and updates the running
// server's license cache IMMEDIATELY on POST/DELETE /api/v1/license (no 60s wait). Auth = the
// logged-in session cookie (storageState), which carries the settings:write scope for the dashboard.

/** PRO: mint + POST a maximal-unlock token (tier business + all areas). Asserts it took. */
export async function setPro(request: APIRequestContext): Promise<void> {
  const res = await request.post("/api/v1/license", {
    headers: { "content-type": "application/json" },
    data: { token: mintProToken() },
  });
  expect(res.status(), `POST /api/v1/license body: ${await res.text()}`).toBe(200);
  const body = await res.json();
  expect(body.data.status).toBe("active");
  expect(body.data.tier).toBe("business");
  await assertTier(request, "business");
}

/** FREE: drop the stored token. Asserts it reverted. */
export async function setFree(request: APIRequestContext): Promise<void> {
  const res = await request.delete("/api/v1/license");
  expect(res.status()).toBe(200);
  await assertTier(request, null);
}

/** Read back the live license tier (GET /api/v1/license) and assert it matches. */
export async function assertTier(request: APIRequestContext, tier: string | null): Promise<void> {
  const res = await request.get("/api/v1/license");
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.data.tier).toBe(tier);
}

// ── Console-error capture ───────────────────────────────────────────────────────────────────
// Tolerated console/network noise:
//  - favicon 404 (no favicon shipped).
//  - The shell's persistent SSE stream (/events/stream) being net::ERR_ABORTED when a FULL-PAGE
//    navigation (e.g. a plain-POST form 303-redirect) tears down the page mid-stream. That's a
//    browser navigation artifact, not a broken SSE — verified by the 40+ htmx-only route loads that
//    open the SAME stream and record ZERO errors (so SSE genuinely connects on a normal load).
const IGNORED_TEXT = [/favicon/i, /^Event$/];
const IGNORED_URL = [/favicon/i, /\/events\/stream/];

export function watchConsole(page: Page): { errors: string[] } {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (IGNORED_TEXT.some((re) => re.test(text))) return;
    errors.push(text);
  });
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  page.on("requestfailed", (req) => {
    const url = req.url();
    // An SSE stream aborted by a page navigation is benign (see note above).
    if (IGNORED_URL.some((re) => re.test(url)) && req.failure()?.errorText?.includes("ERR_ABORTED")) return;
    if (/favicon/i.test(url)) return;
    errors.push(`requestfailed: ${req.method()} ${url} — ${req.failure()?.errorText ?? ""}`);
  });
  return { errors };
}

/** Navigate and assert the page is NOT an error page (no MIKR.US / Internal Server Error / 500
 *  error-card), and that the document title is the brand-suffixed section title. */
export async function gotoOk(page: Page, path: string): Promise<void> {
  // NOT "networkidle": the dashboard shell holds a persistent SSE connection (/events/stream), so the
  // network never goes idle. "domcontentloaded" is the right signal for a server-rendered page.
  const resp = await page.goto(path, { waitUntil: "domcontentloaded" });
  // The dashboard never serves a 5xx for an entitled, logged-in route.
  expect(resp, `no response for ${path}`).toBeTruthy();
  expect(resp!.status(), `${path} returned ${resp!.status()}`).toBeLessThan(500);
  const body = await page.content();
  expect(body, `${path} shows a hosting error page`).not.toContain("MIKR.US");
  expect(body, `${path} shows a framework 500`).not.toContain("Internal Server Error");
}

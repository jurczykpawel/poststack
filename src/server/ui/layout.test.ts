import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";

// The sidebar brand is rendered from BRAND.name (single source). A brand rename via BRAND_NAME
// must flow all the way into the rendered shell with no other change.
describe("dashboard shell brand", () => {
  // layout.ts → env.ts validates required vars at import; give it a minimal valid set.
  beforeAll(() => {
    process.env.DATABASE_URL ||= "postgres://x:y@localhost:5432/z";
    process.env.JWT_SECRET ||= "test-secret-at-least-32-characters-long";
    process.env.TOKEN_ENCRYPTION_KEY ||= "0".repeat(64);
    process.env.APP_URL ||= "http://localhost:3000";
    process.env.CRON_SECRET ||= "test-cron-secret-at-least-32-characters-long";
  });

  const ORIGINAL = process.env.BRAND_NAME;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.BRAND_NAME;
    else process.env.BRAND_NAME = ORIGINAL;
    vi.resetModules();
  });

  async function renderBrand(): Promise<string> {
    vi.resetModules();
    const { dashboardDoc } = await import("./layout");
    const { html } = await import("hono/html");
    const out = await dashboardDoc("T", "/overview", html`<p>x</p>`);
    return out.toString();
  }

  it("renders the default brand PostStack in the sidebar", async () => {
    delete process.env.BRAND_NAME;
    expect(await renderBrand()).toContain(`<div class="brand">PostStack</div>`);
  });

  it("flips the rendered brand when BRAND_NAME is overridden", async () => {
    process.env.BRAND_NAME = "Acme Social";
    const out = await renderBrand();
    expect(out).toContain(`<div class="brand">Acme Social</div>`);
    expect(out).not.toContain("PostStack");
  });
});

import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";

// The sidebar follows the resolved instance identity.
describe("dashboard shell brand", () => {
  // layout.ts → env.ts validates required vars at import; give it a minimal valid set.
  beforeAll(() => {
    process.env.DATABASE_URL ||= "postgres://x:y@localhost:5432/z";
    process.env.JWT_SECRET ||= "test-secret-at-least-32-characters-long";
    process.env.ENCRYPTION_KEY ||= "0".repeat(64);
    process.env.APP_URL ||= "http://localhost:3000";
    process.env.CRON_SECRET ||= "test-cron-secret-at-least-32-characters-long";
  });

  const ORIGINAL = process.env.BRAND_NAME;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.BRAND_NAME;
    else process.env.BRAND_NAME = ORIGINAL;
    vi.resetModules();
  });

  async function renderBrand(name?: string): Promise<string> {
    vi.resetModules();
    const { dashboardDoc } = await import("./layout");
    const { html } = await import("hono/html");
    const { withBrand, DEFAULT_BRAND } = await import("@/lib/brand");
    const render = () => dashboardDoc("T", "/overview", html`<p>x</p>`);
    const out = await (name ? withBrand({ ...DEFAULT_BRAND, name }, render) : render());
    return out.toString();
  }

  it("renders the default brand PostStack in the sidebar (glyph + name)", async () => {
    delete process.env.BRAND_NAME;
    const out = await renderBrand();
    expect(out).toContain(`<span class="brand-glyph">P</span>PostStack`);
  });

  it("flips the rendered brand in the resolved instance context", async () => {
    process.env.BRAND_NAME = "Acme Social";
    const out = await renderBrand("Acme Social");
    expect(out).toContain(`<span class="brand-glyph">A</span>Acme Social`);
    expect(out).not.toContain("PostStack");
  });

  it("uses the first complete character for the fallback logo", async () => {
    const out = await renderBrand("🌻 Social");
    expect(out).toContain('<span class="brand-glyph">🌻</span>🌻 Social');
  });

  it("leaves transitions to document navigation rather than every htmx swap", async () => {
    const out = await renderBrand();
    expect(out).not.toContain('"globalViewTransitions":true');
  });
});

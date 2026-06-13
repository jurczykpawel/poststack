import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("i18n t()", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("interpolates {brand} from BRAND automatically", async () => {
    const { t } = await import("./index");
    const { BRAND } = await import("@/lib/brand");
    expect(t("apiDocs.title")).toBe(`${BRAND.name} API Docs`);
  });

  it("interpolates custom vars and {brand} together", async () => {
    const { t } = await import("./index");
    const { BRAND } = await import("@/lib/brand");
    expect(t("title.suffix", { section: "Inbox" })).toBe(`Inbox · ${BRAND.name}`);
  });

  it("leaves unknown placeholders intact rather than erroring", async () => {
    const { t } = await import("./index");
    // "title.suffix" needs {section}; omitting it must not throw.
    expect(t("title.suffix")).toContain("{section}");
  });
});

describe("BRAND config", () => {
  const ORIGINAL = process.env.BRAND_NAME;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.BRAND_NAME;
    else process.env.BRAND_NAME = ORIGINAL;
    vi.resetModules();
  });

  it("defaults the display name to PostStack", async () => {
    delete process.env.BRAND_NAME;
    vi.resetModules();
    const { BRAND } = await import("@/lib/brand");
    expect(BRAND.name).toBe("PostStack");
  });

  it("lets BRAND_NAME override the display name (working-brand-friendly)", async () => {
    process.env.BRAND_NAME = "Acme Social";
    vi.resetModules();
    const { BRAND } = await import("@/lib/brand");
    expect(BRAND.name).toBe("Acme Social");
  });

  it("keeps machine identifiers brand-neutral (rename must not touch them)", async () => {
    process.env.BRAND_NAME = "Whatever Brand";
    vi.resetModules();
    const { BRAND } = await import("@/lib/brand");
    expect(BRAND.idPrefix).toBe("sk_live_");
    expect(BRAND.cookieName).toBe("session");
    expect(BRAND.jwtIssuer).toBe("stack");
  });
});

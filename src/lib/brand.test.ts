import { describe, expect, it } from "vitest";
import { BRAND, DEFAULT_BRAND, brandingSchema, withBrand } from "./brand";
import { tierFeatures } from "./license/features";

const custom = { ...DEFAULT_BRAND, name: "Orchard", accent: "#12ab34", publicUrl: "https://orchard.example", contactEmail: "help@orchard.example", footer: "Orchard team" };

describe("instance branding", () => {
  it("requires Business for white label", () => {
    expect(tierFeatures("pro").has("white_label")).toBe(false);
    expect(tierFeatures("business").has("white_label")).toBe(true);
  });
  it("validates a complete brand", () => {
    expect(brandingSchema.parse(custom)).toEqual(custom);
  });
  it.each([
    { accent: "red; color: green" }, { publicUrl: "javascript:alert(1)" },
    { logoUrl: "//example.com/logo.svg" }, { faviconUrl: "data:text/html,test" },
    { contactEmail: "not an email" }, { name: "a\nb" }, { theme: "custom" },
    { publicUrl: "https://user:password@example.com" },
  ])("rejects invalid brand fields %j", (patch) => {
    expect(brandingSchema.safeParse({ ...custom, ...patch }).success).toBe(false);
  });
  it("isolates concurrent render contexts and preserves machine identifiers", async () => {
    const result = await Promise.all(["Orchard", "Meadow"].map((name) => withBrand({ ...custom, name }, async () => {
      await Promise.resolve();
      return [BRAND.name, BRAND.cookieName, BRAND.idPrefix, BRAND.jwtIssuer];
    })));
    expect(result).toEqual([["Orchard", "session", "sk_live_", "stack"], ["Meadow", "session", "sk_live_", "stack"]]);
    expect(BRAND.name).toBe("PostStack");
  });
});

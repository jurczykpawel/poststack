import { describe, it, expect } from "vitest";
import { resolveTheme, themeBootScript } from "./theme";

describe("theme", () => {
  it("defaults to dark when no cookie", () => {
    expect(resolveTheme(undefined)).toBe("dark");
  });
  it("resolves light/dark cookies, falls back to dark for system/unknown", () => {
    expect(resolveTheme("dark")).toBe("dark");
    expect(resolveTheme("light")).toBe("light");
    expect(resolveTheme("system")).toBe("dark"); // server can't detect; boot script corrects client-side
    expect(resolveTheme("bogus")).toBe("dark");
  });
  it("boot script sets data-theme before paint and reads the cookie", () => {
    const s = String(themeBootScript());
    expect(s).toContain("data-theme");
    expect(s).toContain("ps_theme");
  });
});

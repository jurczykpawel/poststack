import { describe, it, expect } from "vitest";
import { resolveTheme, themeBootScript } from "./theme";

describe("theme", () => {
  it("defaults to dark when no cookie", () => {
    expect(resolveTheme(undefined)).toBe("dark");
  });
  it("echoes a known theme cookie (v1: only dark defined)", () => {
    expect(resolveTheme("dark")).toBe("dark");
    expect(resolveTheme("bogus")).toBe("dark");
  });
  it("boot script sets data-theme before paint and reads the cookie", () => {
    const s = String(themeBootScript());
    expect(s).toContain("data-theme");
    expect(s).toContain("ps_theme");
  });
});

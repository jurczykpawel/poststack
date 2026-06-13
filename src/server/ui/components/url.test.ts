import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { safeHttpUrl, urlLink } from "./url";

describe("safeHttpUrl", () => {
  it("passes absolute http(s) URLs (scheme case-insensitive)", () => {
    expect(safeHttpUrl("https://x.com/a")).toBe("https://x.com/a");
    expect(safeHttpUrl("http://x.com")).toBe("http://x.com");
    expect(safeHttpUrl("HTTPS://x.com")).toBe("HTTPS://x.com");
  });

  it("rejects dangerous + non-absolute schemes", () => {
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("data:text/html;base64,PHN2Zz4=")).toBeNull();
    expect(safeHttpUrl("vbscript:msgbox(1)")).toBeNull();
    expect(safeHttpUrl(" javascript:alert(1)")).toBeNull(); // leading whitespace can't sneak past
    expect(safeHttpUrl("//evil.com")).toBeNull(); // protocol-relative
    expect(safeHttpUrl("/admin/x")).toBeNull();
    expect(safeHttpUrl("")).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
    expect(safeHttpUrl(undefined)).toBeNull();
  });

  it("urlLink renders a link for http(s) and inert <code> otherwise", () => {
    expect(String(urlLink("https://x.com", "go"))).toContain('href="https://x.com"');
    const bad = String(urlLink("javascript:alert(1)"));
    expect(bad).not.toContain("href=");
    expect(bad).toContain("<code");
    expect(String(urlLink(null))).toBe("");
  });
});

describe("PSA4 class guard — no DB URL reaches href/src unguarded", () => {
  // Pins the fix + prevents the class regrowing in these files: the raw DB-url identifiers must
  // never be interpolated straight into an href/src; they go through safeHttpUrl/urlLink.
  // The content/queue publishing sections land in Phase-3 Tasks 3 & 6; until then the guard
  // case is gated on the section existing, so it activates the moment the section is ported.
  const tryRead = (f: string): string | null => {
    try {
      return readFileSync(new URL(`../sections/${f}`, import.meta.url), "utf8");
    } catch {
      return null;
    }
  };

  it("content.ts routes published_url through the guard", () => {
    const src = tryRead("content.ts");
    if (!src) return; // not yet ported (Task 3)
    expect(src).not.toMatch(/href="\$\{post\.published_url\}"/);
    expect(src).toContain("urlLink(post.published_url");
  });

  it("queue.ts routes the provider handle + media src through the guard", () => {
    const src = tryRead("queue.ts");
    if (!src) return; // not yet ported (Task 6)
    expect(src).not.toMatch(/href="\$\{post\.provider_handle\}"/);
    expect(src).not.toMatch(/src="\$\{media\.url\}"/);
    expect(src).toMatch(/urlLink\(post\.provider_handle\)/);
    expect(src).toContain("safeHttpUrl(media.url)");
  });
});

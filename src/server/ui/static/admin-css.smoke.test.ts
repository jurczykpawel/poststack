import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The visual layer is hand-written CSS; this guards the contract that markup
// relies on (key selectors exist) and the doctrine (no raw hex — colors must
// come from tokens.css custom properties, never literal values in admin.css).
const css = readFileSync(join(process.cwd(), "src/server/ui/static/admin.css"), "utf8");

describe("admin.css visual layer", () => {
  it("declares the @layer order with components + utilities", () => {
    expect(css).toMatch(/@layer\s+base\s*,\s*components\s*,\s*utilities\s*;/);
  });

  it.each([
    ".app",
    ".sidebar",
    ".brand-glyph",
    ".nav-item",
    ".nav-item.is-active",
    ".topbar",
    ".content",
    ".btn",
    ".btn-primary",
    ".btn-secondary",
    ".btn-danger",
    ".btn-ghost",
    ".badge",
    ".pill",
    ".dot",
    ".platform",
    ".auth-card",
    ".auth-error",
    ".mobile-nav",
  ])("defines the %s selector", (sel) => {
    expect(css).toContain(sel);
  });

  it("styles tables (a `table` rule and a `.table-wrap` scroll container)", () => {
    expect(css).toMatch(/(^|\s)table\s*\{/m);
    expect(css).toContain(".table-wrap");
  });

  it("ships responsive breakpoints (sidebar collapse + table card transform)", () => {
    expect(css).toMatch(/@media[^{]*max-width:\s*1023/);
    expect(css).toMatch(/@media[^{]*max-width:\s*767/);
    expect(css).toContain("data-label");
  });

  it("honors reduced motion", () => {
    expect(css).toMatch(/prefers-reduced-motion/);
  });

  it("ships a11y utilities: a visually-hidden class and a focus-revealed skip link", () => {
    expect(css).toContain(".sr-only");
    expect(css).toContain(".skip-link");
    expect(css).toMatch(/\.skip-link:focus-visible/);
  });

  it("styles the HTMX-driven toast + confirm-dialog surfaces (and hides x-cloak)", () => {
    expect(css).toContain("[x-cloak]");
    expect(css).toContain(".toast");
    expect(css).toContain(".confirm-overlay");
    expect(css).toContain(".confirm-card");
  });

  it("styles the ⌘K palette + the live-poll pulse dot", () => {
    expect(css).toContain(".cmdk-panel");
    expect(css).toContain(".cmdk-item");
    expect(css).toContain(".cmdk-trigger");
    expect(css).toContain(".live-dot");
  });

  it("contains NO raw hex colors — every color comes from a token", () => {
    const hex = css.match(/#[0-9a-fA-F]{3,6}\b/g);
    expect(hex, `unexpected raw hex in admin.css: ${hex?.join(", ")}`).toBeNull();
  });
});

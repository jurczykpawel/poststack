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

  // Bug: .conv-unread was position:absolute at the SAME right edge as .conv-time, overlapping the
  // timestamp text. Fixed by flowing both inside one flex wrapper instead of floating the dot on top.
  it("keeps the unread dot in normal flex flow (not position:absolute) so it can't overlap the timestamp", () => {
    expect(css).toContain(".conv-time-wrap");
    const unreadRule = css.match(/\.conv-unread\s*\{[^}]*\}/)?.[0] ?? "";
    expect(unreadRule).not.toContain("position: absolute");
  });

  // Bug: .conv-item is a bare <button> (whole clickable inbox row, not a `.btn` action button) that
  // inherited the global htmx-request::before spinner — an INSERTED pseudo-element that reflowed the
  // row's flex layout for the request's duration, looking like a jump to the right on click.
  it("suppresses the global htmx-request spinner on .conv-item (it would reflow the row)", () => {
    expect(css).toMatch(/\.conv-item\.htmx-request::before\s*\{[^}]*content:\s*none/);
  });

  // Follow-up: removing the spinner outright left NO click feedback at all (felt broken/unresponsive).
  // Fix: hide the timestamp text (visibility:hidden — its layout space stays reserved) and overlay a
  // spinner ABSOLUTELY positioned in that same reserved slot, so it appears without taking or shifting
  // any layout space — the "neutral position" the owner asked for.
  it("shows a non-reflowing spinner over the (space-reserving) hidden timestamp while a conv-item request is in flight", () => {
    expect(css).toMatch(/\.conv-item\.htmx-request\s+\.conv-time\s*\{[^}]*visibility:\s*hidden/);
    const overlayRule = css.match(/\.conv-item\.htmx-request\s+\.conv-time-wrap::after\s*\{[^}]*\}/)?.[0] ?? "";
    expect(overlayRule).toContain("position: absolute");
    expect(overlayRule).toContain("ps-spin");
  });
});

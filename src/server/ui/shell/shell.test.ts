import { describe, it, expect, beforeAll } from "vitest";
import { html } from "hono/html";
import type { Feature } from "@/lib/license/features";
import type { Area } from "@/lib/license/areas";

// layout.ts → env.ts validates required vars at import; set them before the dynamic import.
process.env.DATABASE_URL ||= "postgres://x:y@localhost:5432/z";
process.env.JWT_SECRET ||= "test-secret-at-least-32-characters-long";
process.env.ENCRYPTION_KEY ||= "0".repeat(64);
process.env.APP_URL ||= "http://localhost:3000";
process.env.CRON_SECRET ||= "test-cron-secret-at-least-32-characters-long";

let renderPage: typeof import("../layout").renderPage;
let NAV_SECTIONS: typeof import("./nav").NAV_SECTIONS;
let isActive: typeof import("./nav").isActive;

const s = (h: unknown) => String(h);
const ALL_AREAS = new Set<Area>(["core", "publishing", "replies"]);
const ALL_FEATURES = new Set<Feature>([
  "contacts_crm", "sequences", "multi_brand", "managed_connection", "api_access",
]);

beforeAll(async () => {
  ({ renderPage } = await import("../layout"));
  ({ NAV_SECTIONS, isActive } = await import("./nav"));
});

describe("unified nav config", () => {
  it("has the publish + reply wings under named sections", () => {
    const names = NAV_SECTIONS.map((x) => x.section);
    expect(names).toEqual(["Overview", "Replies", "Publishing", "Delivery"]);
    const keys = NAV_SECTIONS.flatMap((x) => x.items.map((i) => i.key));
    expect(keys).toEqual(expect.arrayContaining([
      "overview", "channels", "brands", "sources", // overview
      "inbox", "rules", "contacts", "sequences", // replies
      "compose", "content", "queue", // publishing
      "webhooks", "api-keys", "events", // delivery
    ]));
  });
  it("marks the current section active (key or href path)", () => {
    expect(isActive("channels", "/channels")).toBe(true);
    expect(isActive("channels", "/channels/abc")).toBe(true);
    expect(isActive("overview", "/overview")).toBe(true);
    expect(isActive("overview", "/")).toBe(true);
    expect(isActive("queue", "/channels")).toBe(false);
  });
});

describe("renderPage shell", () => {
  it("emits data-theme, tokens link, vendored libs, sidebar nav and the body", async () => {
    const out = s(await renderPage({ title: "Channels", nav: "channels", body: html`<p id="x">hi</p>`, features: ALL_FEATURES, products: ALL_AREAS }));
    expect(out).toContain('data-theme="dark"');
    expect(out).toContain("/static/tokens.css");
    expect(out).toContain("/static/vendor/alpine-3.14.9.min.js");
    expect(out).toContain("/static/vendor/htmx-2.0.4.min.js");
    expect(out).toContain('aria-current="page"');
    expect(out).toContain('id="x"');
    expect(out).toContain('role="status"');
  });

  it("wires the realtime SSE connection into the shell (REALTIME1 R4)", async () => {
    const out = s(await renderPage({ title: "Inbox", nav: "inbox", body: html`<p>x</p>`, products: ALL_AREAS }));
    expect(out).toContain("/static/vendor/htmx-ext-sse-2.2.2.js");
    expect(out).toContain('hx-ext="sse"');
    expect(out).toContain('sse-connect="/events/stream"');
  });

  it("wires the Alpine toast store + styled confirm dialog into the shell", async () => {
    const out = s(await renderPage({ title: "Overview", nav: "overview", body: html`<p>x</p>`, products: ALL_AREAS }));
    expect(out).toContain("<body x-data>");
    expect(out).toMatch(/class="toasts"[^>]*aria-live="polite"/);
    expect(out).toContain('role="alertdialog"');
    expect(out).toContain("ps:toast");
    expect(out).toContain("htmx:confirm");
  });

  it("ships the ⌘K command palette + its topbar trigger, listing real nav targets", async () => {
    const out = s(await renderPage({ title: "Overview", nav: "overview", body: html`<p>x</p>`, products: ALL_AREAS }));
    expect(out).toContain('aria-label="Command palette"');
    expect(out).toContain("psPalette");
    expect(out).toContain('aria-label="Open command palette"');
    expect(out).toContain("⌘K");
    expect(out).toContain("/channels");
    expect(out).toMatch(/"label":"Compose"/);
    expect(out).not.toMatch(/"href":"#"/);
  });
});

describe("area-gated nav (publish vs reply wings)", () => {
  it("a replies-only license hides publishing nav items", async () => {
    const out = s(await renderPage({ title: "Inbox", nav: "inbox", body: html`<p>x</p>`, features: ALL_FEATURES, products: new Set<Area>(["core", "replies"]) }));
    expect(out).toContain(">Inbox<");
    expect(out).not.toContain("Publishing");
    expect(out).not.toContain('href="/compose"');
    expect(out).not.toContain('href="/queue"');
  });

  it("a publishing-only license hides reply nav items", async () => {
    const out = s(await renderPage({ title: "Content", nav: "content", body: html`<p>x</p>`, features: ALL_FEATURES, products: new Set<Area>(["core", "publishing"]) }));
    expect(out).toContain('href="/content"');
    expect(out).not.toContain("Replies");
    expect(out).not.toContain('href="/inbox"');
    expect(out).not.toContain('href="/rules"');
  });

  it("a suite license shows both wings", async () => {
    const out = s(await renderPage({ title: "Overview", nav: "overview", body: html`<p>x</p>`, features: ALL_FEATURES, products: ALL_AREAS }));
    expect(out).toContain("Replies");
    expect(out).toContain("Publishing");
  });

  it("a missing feature locks its item (🔒 PRO link to upgrade) without hiding it", async () => {
    const out = s(await renderPage({ title: "Overview", nav: "overview", body: html`<p>x</p>`, features: new Set<Feature>(), products: ALL_AREAS }));
    // Brands needs multi_brand → locked: rendered as a PRO link, not its real href.
    expect(out).toContain("nav-locked");
    expect(out).toContain("PRO");
  });
});

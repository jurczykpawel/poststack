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
    expect(names).toEqual(["", "Publishing", "Conversations", "Automation", "Setup"]);
    const keys = NAV_SECTIONS.flatMap((x) => x.items.map((i) => i.key));
    expect(keys).toEqual(expect.arrayContaining([
      "overview", "channels", "brands", // overview (sources moved into Settings → Sources tab)
      "inbox", "rules", "contacts", "sequences", // replies
      "content", "queue", "approvals", // publishing + approvals
      "webhooks", "activity", // delivery
    ]));
    // sources + api-keys moved into Settings tabs, not top-level nav items.
    expect(keys).not.toContain("sources");
    expect(keys).not.toContain("api-keys");
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
    expect(out).toContain("htmx:sendError"); // MQA18-B04
    expect(out).toContain("htmx:responseError");
  });

  it("ships the ⌘K command palette + its topbar trigger, listing real nav targets", async () => {
    const out = s(await renderPage({ title: "Overview", nav: "overview", body: html`<p>x</p>`, products: ALL_AREAS }));
    expect(out).toContain('aria-label="Command palette"');
    expect(out).toContain("psPalette");
    expect(out).toContain('aria-label="Open command palette"');
    expect(out).toContain("⌘K");
    expect(out).toContain('{"label":"Connect channel","href":"/channels?connect=1"');
    expect(out).toMatch(/"label":"New post"/);
    expect(out).not.toMatch(/"href":"#"/);
  });
});

describe("UXFLOW1 stage 1 menu", () => {
  it("sidebar has the New post button and a unique icon per item", async () => {
    const out = s(await renderPage({ title: "Queue", nav: "queue", body: html`<p>x</p>`, features: ALL_FEATURES, products: ALL_AREAS }));
    expect(out).toContain('class="side-new" href="/compose"');
    const { allNavItems } = await import("./nav");
    const icons = allNavItems().map((i) => i.icon);
    expect(new Set(icons).size).toBe(icons.length);
  });
  it("phone bar is Overview, Queue, New post, Inbox, More (sheet)", async () => {
    const out = s(await renderPage({ title: "Overview", nav: "overview", body: html`<p>x</p>`, features: ALL_FEATURES, products: ALL_AREAS }));
    const bar = out.slice(out.indexOf('class="mobile-nav"'));
    const hrefs = [...bar.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]).slice(0, 4);
    expect(hrefs).toEqual(["/overview", "/queue", "/compose", "/inbox"]);
    expect(bar).toContain('aria-controls="mnav-more"');
    expect(bar.slice(bar.indexOf('id="mnav-more"'))).toContain('href="/settings"');
  });
  it("count badges render only when > 0 and Channels is flagged bad", async () => {
    const { navCountsFragment } = await import("./nav-counts");
    const frag = s(navCountsFragment({ inbox: 3, approvals: 0, channels: 2 }));
    expect(frag).toContain('id="nav-n-inbox"');
    expect(frag).toContain(">3<");
    expect(frag).not.toMatch(/id="nav-n-approvals"[^>]*>\s*[1-9]/);
    expect(frag).toMatch(/id="nav-n-channels"[^>]*class="[^"]*bad/);
    expect(frag).toContain('id="mnav-n-inbox"');
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
    expect(out).not.toContain("Conversations");
    expect(out).not.toContain('href="/inbox"');
    expect(out).not.toContain('href="/rules"');
  });

  it("a suite license shows both wings", async () => {
    const out = s(await renderPage({ title: "Overview", nav: "overview", body: html`<p>x</p>`, features: ALL_FEATURES, products: ALL_AREAS }));
    expect(out).toContain("Conversations");
    expect(out).toContain("Publishing");
  });

  it("a missing feature locks its item (🔒 PRO link to upgrade) without hiding it", async () => {
    const out = s(await renderPage({ title: "Overview", nav: "overview", body: html`<p>x</p>`, features: new Set<Feature>(), products: ALL_AREAS }));
    // Feature-gated items (e.g. Sources→managed_connection, Sequences→sequences) render locked: a PRO
    // link to upgrade, not their real href. (Brands is open-core — ungated — so it is NOT among these.)
    expect(out).toContain("nav-locked");
    expect(out).toContain("PRO");
  });
});

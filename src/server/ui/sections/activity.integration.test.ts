import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import type { Hono } from "hono";
import { eq } from "drizzle-orm";

const TEST_DB = process.env.TEST_DATABASE_URL;

let app: Hono;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let cookie: string;

const WS = "aaaaaaaa-0000-4000-8000-0000000000a1";
const OTHER_WS = "aaaaaaaa-0000-4000-8000-0000000000b1";
const USER = "aaaaaaaa-0000-4000-8000-0000000000a2";
const CH = "aaaaaaaa-0000-4000-8000-0000000000c1";
const OTHER_CH = "aaaaaaaa-0000-4000-8000-0000000000c2";

const get = async (path: string) => {
  const res = await app.request(path, { headers: { cookie } });
  expect(res.status).toBe(200);
  return res.text();
};
const rowIds = (body: string) => [...body.matchAll(/data-row="([0-9a-f-]{36})"/g)].map((m) => m[1]!);
const decode = (href: string) => href.replace(/&amp;/g, "&");
const pagerLink = (body: string, rel: "next" | "prev") => {
  const m = new RegExp(`<a[^>]*rel="${rel}"[^>]*href="([^"]+)"|<a[^>]*href="([^"]+)"[^>]*rel="${rel}"`).exec(body);
  return m ? decode((m[1] ?? m[2])!) : null;
};
const chipCount = (body: string, label: string) => {
  const m = new RegExp(`class="dl-chip[^"]*"[^>]*>\\s*${label}\\s*<b>([\\d,]+)</b>`).exec(body);
  return m ? Number(m[1]!.replace(/,/g, "")) : null;
};

let seq = 0;
async function seedHook(rows: Array<Partial<typeof import("@/db/schema").webhookEvents.$inferInsert>>, channel = CH) {
  return db.insert(s.webhookEvents).values(rows.map((r) => ({
    event_key: `act-${++seq}-${Math.random()}`, channel_id: channel, platform: "facebook" as const, event_type: "message", raw: {}, ...r,
  }))).returning({ id: s.webhookEvents.id });
}

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  const { buildApp } = await import("../../app");
  app = buildApp();
  const { signSession } = await import("@/lib/auth");
  cookie = `session=${await signSession(USER, WS)}`;
});

beforeEach(async () => {
  if (!TEST_DB) return;
  for (const id of [WS, OTHER_WS]) await db.delete(s.workspaces).where(eq(s.workspaces.id, id));
  await db.delete(s.users).where(eq(s.users.id, USER));
  await db.insert(s.users).values({ id: USER, email: `u-${USER}@test.local` });
  await db.insert(s.workspaces).values([{ id: WS, name: "A", slug: `a-${WS}` }, { id: OTHER_WS, name: "B", slug: `b-${OTHER_WS}` }]);
  await db.insert(s.workspaceMembers).values({ workspace_id: WS, user_id: USER, role: "owner" });
  await db.insert(s.channels).values([
    { id: CH, workspace_id: WS, platform: "facebook", platform_id: "FB-A", display_name: "Acme Page", token_encrypted: "x", webhook_secret: "s", status: "active" },
    { id: OTHER_CH, workspace_id: OTHER_WS, platform: "facebook", platform_id: "FB-B", display_name: "Foreign Page", token_encrypted: "x", webhook_secret: "s", status: "active" },
  ]);
});

describe("old addresses redirect to /activity", () => {
  it("/events keeps its query and lands on the events source", async () => {
    if (!TEST_DB) return;
    const res = await app.request("/events?severity=problems&q=reauth", { headers: { cookie } });
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location")!, "http://x");
    expect(to.pathname).toBe("/activity");
    expect(Object.fromEntries(to.searchParams)).toEqual({ source: "events", severity: "problems", q: "reauth" });
  });

  it("/webhooks/:id opens that event in the webhooks source", async () => {
    if (!TEST_DB) return;
    const [ev] = await seedHook([{}]);
    const res = await app.request(`/webhooks/${ev!.id}`, { headers: { cookie } });
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location")!, "http://x");
    expect(to.pathname).toBe("/activity");
    expect(Object.fromEntries(to.searchParams)).toEqual({ source: "webhooks", open: ev!.id });
  });

  it("/webhooks itself and its static sub-routes still work", async () => {
    if (!TEST_DB) return;
    expect((await app.request("/webhooks", { headers: { cookie } })).status).toBe(200);
    expect((await app.request("/webhooks/subscriptions", { headers: { cookie } })).status).toBe(200);
  });
});

describe("/activity sources", () => {
  it("defaults to events and offers the three sources as links, marking the current one", async () => {
    if (!TEST_DB) return;
    await db.insert(s.events).values({ workspace_id: WS, type: "post.failed" });
    const body = await get("/activity");
    expect(body).toContain("Post failed");
    for (const [key, label] of [["events", "Events"], ["webhooks", "Webhooks"], ["ai", "AI log"]]) {
      expect(body).toMatch(new RegExp(`<a[^>]*href="/activity\\?source=${key}"[^>]*>\\s*${label}`));
    }
    expect(body).toMatch(/<a[^>]*aria-current="page"[^>]*>\s*Events/);
    // paging/filter links of the events list stay on this address and source
    expect(body).toMatch(/href="\/activity\?source=events&amp;severity=problems"/);
  });

  it("an unknown source falls back to events", async () => {
    if (!TEST_DB) return;
    expect(await get("/activity?source=nope")).toMatch(/<a[^>]*aria-current="page"[^>]*>\s*Events/);
  });
});

describe("/activity?source=webhooks", () => {
  const url = (q = "") => `/activity?source=webhooks${q}`;

  it("lists only this workspace's channels' deliveries, with the channel name", async () => {
    if (!TEST_DB) return;
    await seedHook([{ event_type: "messages", handling_status: "fired" }]);
    await seedHook([{ event_type: "FOREIGN_EVENT" }], OTHER_CH);
    const body = await get(url());
    expect(body).toContain("Acme Page");
    expect(body).not.toContain("FOREIGN_EVENT");
    expect(body).not.toContain("Foreign Page");
    expect(rowIds(body)).toHaveLength(1);
  });

  it("chips count by handling status, honour other filters, and filter", async () => {
    if (!TEST_DB) return;
    await seedHook([
      { handling_status: "fired", platform: "facebook" },
      { handling_status: "fired", platform: "instagram" },
      { handling_status: "error", error_detail: "Provider returned 400", platform: "instagram" },
      { handling_status: "no_match", platform: "instagram" },
    ]);
    const all = await get(url());
    expect(chipCount(all, "All")).toBe(4);
    expect(chipCount(all, "fired")).toBe(2);
    expect(chipCount(all, "error")).toBe(1);
    const ig = await get(url("&platform=instagram"));
    expect(chipCount(ig, "All")).toBe(3);
    expect(chipCount(ig, "fired")).toBe(1);
    const errors = await get(url("&status=error"));
    expect(rowIds(errors)).toHaveLength(1);
    expect(errors).toContain("Provider returned 400");
    expect(chipCount(errors, "fired")).toBe(2); // siblings stay one click away
  });

  it("searches event type, error text and channel name", async () => {
    if (!TEST_DB) return;
    await seedHook([{ event_type: "message_reactions" }, { event_type: "messages", handling_status: "error", error_detail: "Token expired for page" }]);
    expect(rowIds(await get(url("&q=reactions")))).toHaveLength(1);
    expect(rowIds(await get(url("&q=token%20expired")))).toHaveLength(1);
    expect(rowIds(await get(url("&q=acme")))).toHaveLength(2);
    expect(await get(url("&q=zzz"))).toContain("No events match");
  });

  it("pages through every row once going older and back, across equal timestamps", async () => {
    if (!TEST_DB) return;
    const same = new Date("2026-10-01T10:00:00.000Z");
    await seedHook(Array.from({ length: 120 }, () => ({ received_at: same })));
    const first = await get(url());
    expect(first).toContain("1–50 of 120");
    const second = await get(pagerLink(first, "next")!);
    const third = await get(pagerLink(second, "next")!);
    expect(third).toContain("101–120 of 120");
    expect(new Set([...rowIds(first), ...rowIds(second), ...rowIds(third)]).size).toBe(120);
    expect(second).toContain("source=webhooks"); // paging keeps the source
    expect(rowIds(await get(pagerLink(third, "prev")!))).toEqual(rowIds(second));
  });

  it("opens an event: payload, resolved sender name, what it triggered, link to the conversation", async () => {
    if (!TEST_DB) return;
    const [contact] = await db.insert(s.contacts).values({ workspace_id: WS }).returning({ id: s.contacts.id });
    const [conv] = await db.insert(s.conversations).values({ workspace_id: WS, channel_id: CH, contact_id: contact!.id, platform: "facebook", status: "open" }).returning({ id: s.conversations.id });
    const [ev] = await seedHook([{
      event_type: "post_reaction", field: "feed", sender_id: "SENDER-1", handling_status: "fired", conversation_id: conv!.id,
      raw: { entry: [{ changes: [{ value: { from: { id: "SENDER-1", name: "Noémie Pfirsch" } } }] }] },
    }]);
    const body = await get(url(`&open=${ev!.id}`));
    expect(body).toContain("Noémie Pfirsch");
    expect(body).toContain("Raw payload");
    expect(body).toContain(`href="/inbox/${conv!.id}"`);
    expect(body).toMatch(/aria-label="Close details"/);
  });

  it("does not open another workspace's event, even by id", async () => {
    if (!TEST_DB) return;
    const [ev] = await seedHook([{ event_type: "FOREIGN_EVENT" }], OTHER_CH);
    const body = await get(url(`&open=${ev!.id}`));
    expect(body).not.toContain("FOREIGN_EVENT");
    expect(body).not.toContain('aria-label="Details"');
  });

  it("shows the empty state when nothing has arrived", async () => {
    if (!TEST_DB) return;
    expect(await get(url())).toContain("No webhook events yet");
  });
});

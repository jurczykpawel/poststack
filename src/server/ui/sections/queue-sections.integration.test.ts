import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { users, workspaces, channels, deliveries, posts, rateLimitCounters } from "@/db/schema";
import { licenseInstance } from "@/lib/license/__fixtures__/license-instance";

const TEST_DB = process.env.TEST_DATABASE_URL;
const EMAIL = "queue-sections@example.test";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let db: typeof import("@/lib/db").db;
let encryptTokens: typeof import("@/lib/crypto").encryptTokens;
let closeQueue: typeof import("@/lib/queue/client").closeQueue;
let app: Hono;
let cookie = "";
let workspaceId = "";
let channelId = "";

type Status = (typeof deliveries.$inferInsert)["status"];

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  process.env.REGISTRATION_ENABLED = "true";
  delete process.env.ALTCHA_HMAC_KEY;
  ({ db } = await import("@/lib/db"));
  ({ encryptTokens } = await import("@/lib/crypto"));
  ({ closeQueue } = await import("@/lib/queue/client"));
  const { buildApp } = await import("../../app");
  app = buildApp();
  await licenseInstance();
  await db.delete(rateLimitCounters);
  await db.delete(workspaces);
  await db.delete(users).where(eq(users.email, EMAIL));
  const res = await app.request("/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: "supersecret123" }),
  });
  cookie = (res.headers.get("set-cookie") ?? "").match(/session=[^;]+/)![0];
  const user = await db.query.users.findFirst({
    where: eq(users.email, EMAIL), columns: {},
    with: { workspaceMembers: { columns: { workspace_id: true }, limit: 1 } },
  });
  workspaceId = user!.workspaceMembers[0].workspace_id;
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  await db.delete(users).where(eq(users.email, EMAIL));
  await closeQueue();
  await db.$client.end();
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.delete(deliveries).where(eq(deliveries.workspace_id, workspaceId));
  await db.delete(channels).where(eq(channels.workspace_id, workspaceId));
  channelId = await addChannel(workspaceId, "Main page");
});

async function addChannel(ws: string, name: string, platform: "facebook" | "tiktok" | "linkedin" = "facebook"): Promise<string> {
  const [ch] = await db.insert(channels).values({
    workspace_id: ws, platform, platform_id: `acct-${Math.random()}`, display_name: name,
    token_encrypted: encryptTokens({ access_token: "t" }), webhook_secret: "w", status: "active",
  }).returning({ id: channels.id });
  return ch!.id;
}

async function seed(o: { status: Status; at?: Date; caption?: string; format?: string; ws?: string; channel?: string; lastError?: string }): Promise<string> {
  const at = o.at ?? new Date();
  const format = o.format ?? "text";
  const [d] = await db.insert(deliveries).values({
    workspace_id: o.ws ?? workspaceId, channel_id: o.channel ?? channelId, format, status: o.status,
    payload: { format, media: [], caption: o.caption ?? "Some caption" }, scheduled_at: at, run_at: at, last_error: o.lastError ?? null,
  }).returning({ id: deliveries.id });
  return d!.id;
}

async function seedMany(n: number, status: Status, when: (i: number) => Date, caption: (i: number) => string = (i) => `${status} ${i}`): Promise<void> {
  await db.insert(deliveries).values(Array.from({ length: n }, (_, i) => ({
    workspace_id: workspaceId, channel_id: channelId, format: "text", status,
    payload: { format: "text", media: [], caption: caption(i) }, scheduled_at: when(i), run_at: when(i),
  })));
}

const page = async (path: string, extraCookie = "") =>
  (await app.request(path, { headers: { cookie: extraCookie ? `${cookie}; ${extraCookie}` : cookie } })).text();

/** One section's markup, the way a reader would look for rows in it. */
function section(out: string, name: "scheduled" | "published" | "canceled"): string {
  const at = out.indexOf(`data-section="${name}"`);
  if (at < 0) throw new Error(`no section ${name}`);
  const ends = [out.indexOf('data-section="', at + 1), out.indexOf('class="dl-detail"', at)].filter((i) => i > 0);
  return out.slice(at, ends.length ? Math.min(...ends) : undefined);
}
const order = (out: string, needles: string[]) => needles.map((n) => out.indexOf(n));
const ascending = (xs: number[]) => xs.every((x, i) => x >= 0 && (i === 0 || x > xs[i - 1]!));
const rowCount = (out: string) => (out.match(/data-row="/g) ?? []).length;

const htmx = (url: string) => ({ cookie, "HX-Request": "true", "HX-Target": "data-list", "HX-Current-URL": `http://localhost:3000${url}`, "content-type": "application/x-www-form-urlencoded" });

describe("queue sections", () => {
  it("shows scheduled, published, canceled in that order, each with its own count, whatever the volume of the others", async () => {
    if (!TEST_DB) return;
    await seedMany(260, "scheduled", (i) => new Date(Date.now() + HOUR + i * 60_000));
    await seed({ status: "sent", caption: "Published survivor" });
    await seed({ status: "canceled", caption: "Canceled survivor" });
    const out = await page("/queue");
    expect(ascending(order(out, ['data-section="scheduled"', 'data-section="published"', 'data-section="canceled"']))).toBe(true);
    expect(section(out, "scheduled")).toContain(">260<");
    expect(section(out, "published")).toContain("Published survivor");
    expect(section(out, "canceled")).toContain("Canceled survivor");
    expect(rowCount(section(out, "scheduled"))).toBe(12);
  });

  it("puts post text in the row and leaves attempts and errors out of the list", async () => {
    if (!TEST_DB) return;
    await seed({ status: "scheduled", at: new Date(Date.now() + HOUR), caption: "Black Friday <b>price</b> 99" });
    const out = await page("/queue");
    expect(out).toContain("Black Friday &lt;b&gt;price&lt;/b&gt; 99");
    expect(out).not.toContain("Black Friday <b>");
    expect(section(out, "scheduled")).not.toContain("Attempts");
    expect(section(out, "scheduled")).not.toContain("Last error");
  });

  it("orders scheduled soonest first and published newest first", async () => {
    if (!TEST_DB) return;
    await seed({ status: "scheduled", at: new Date(Date.now() + 3 * DAY), caption: "sched-late" });
    await seed({ status: "scheduled", at: new Date(Date.now() + HOUR), caption: "sched-soon" });
    await seed({ status: "sent", at: new Date(Date.now() - 3 * DAY), caption: "sent-old" });
    await seed({ status: "sent", at: new Date(Date.now() - HOUR), caption: "sent-new" });
    const out = await page("/queue");
    expect(ascending(order(section(out, "scheduled"), ["sched-soon", "sched-late"]))).toBe(true);
    expect(ascending(order(section(out, "published"), ["sent-new", "sent-old"]))).toBe(true);
  });

  it("keeps posts being sent visible among the scheduled ones", async () => {
    if (!TEST_DB) return;
    await seed({ status: "sending", at: new Date(Date.now() - 60_000), caption: "going out" });
    await seed({ status: "processing", at: new Date(Date.now() - 120_000), caption: "still processing" });
    const scheduled = section(await page("/queue"), "scheduled");
    expect(scheduled).toContain("going out");
    expect(scheduled).toContain("still processing");
    expect(scheduled).toContain(">2<");
  });

  it("Show 20 more grows only its section; the count stays exact and the size is bounded", async () => {
    if (!TEST_DB) return;
    await seedMany(240, "sent", (i) => new Date(Date.now() - HOUR - i * 60_000));
    await seed({ status: "scheduled", at: new Date(Date.now() + HOUR) });
    const first = section(await page("/queue"), "published");
    expect(rowCount(first)).toBe(6);
    expect(first).toContain("show_published=26");
    expect(first).toContain("6 of 240");
    expect(first).toContain("/queue?status=published");
    const more = section(await page("/queue?show_published=26"), "published");
    expect(rowCount(more)).toBe(26);
    expect(more).toContain("26 of 240");
    expect(rowCount(section(await page("/queue?show_published=99999"), "published"))).toBe(200);
    expect(rowCount(section(await page("/queue?show_published=abc"), "published"))).toBe(6);
  });

  it("opens the canceled section only when asked, or when its row is open", async () => {
    if (!TEST_DB) return;
    const id = await seed({ status: "canceled" });
    const openAttr = (out: string) => /^data-section="canceled"[^>]*\bopen\b/.test(section(out, "canceled"));
    expect(openAttr(await page("/queue"))).toBe(false);
    expect(openAttr(await page(`/queue?open=${id}`))).toBe(true);
  });

  it("offers every channel and format as a filter, including ones outside the rows on screen", async () => {
    if (!TEST_DB) return;
    await addChannel(workspaceId, "Quiet channel");
    await seedMany(210, "sent", (i) => new Date(Date.now() - HOUR - i * 60_000));
    await seed({ status: "sent", format: "carousel", at: new Date(Date.now() - 30 * DAY) });
    const out = await page("/queue");
    expect(out).toContain("Quiet channel");
    expect(out).toMatch(/<option value="carousel"/);
    const narrowed = await page("/queue?format=carousel");
    expect(narrowed).toMatch(/<option value="text"/);
    expect(section(narrowed, "published")).toContain(">1<");
  });

  it("search matches post text and channel name literally, and counts follow it", async () => {
    if (!TEST_DB) return;
    const other = await addChannel(workspaceId, "Promo page");
    await seed({ status: "sent", caption: "Spring 100% sale" });
    await seed({ status: "sent", caption: "Spring 100 sale" });
    await seed({ status: "scheduled", channel: other, at: new Date(Date.now() + HOUR), caption: "unrelated" });
    const byText = await page(`/queue?q=${encodeURIComponent("100%")}`);
    expect(byText).toContain("Spring 100% sale");
    expect(byText).not.toContain("Spring 100 sale");
    expect(section(byText, "published")).toContain(">1<");
    const byChannel = section(await page("/queue?q=promo"), "scheduled");
    expect(byChannel).toContain("unrelated");
  });

  it("filter by channel narrows the sections; a malformed channel id is ignored", async () => {
    if (!TEST_DB) return;
    const other = await addChannel(workspaceId, "Second page");
    await seed({ status: "sent", caption: "On first" });
    await seed({ status: "sent", channel: other, caption: "On second" });
    const out = await page(`/queue?channel=${other}`);
    expect(out).toContain("On second");
    expect(out).not.toContain("On first");
    const res = await app.request("/queue?channel=not-a-uuid", { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("On first");
  });

  it("shows nothing from another workspace, in rows or counters", async () => {
    if (!TEST_DB) return;
    const [other] = await db.insert(workspaces).values({ name: "Other", slug: `other-${Math.random().toString(36).slice(2)}` }).returning();
    const ch = await addChannel(other!.id, "Foreign channel");
    await seed({ ws: other!.id, channel: ch, status: "failed", caption: "Foreign failed" });
    const foreign = await seed({ ws: other!.id, channel: ch, status: "scheduled", caption: "Foreign scheduled" });
    const out = await page(`/queue?open=${foreign}`);
    expect(out).not.toContain("Foreign");
    expect(out).not.toContain("need your attention");
    expect(await page("/queue?status=scheduled")).not.toContain("Foreign");
    await db.delete(workspaces).where(eq(workspaces.id, other!.id));
  });

  it("offers the composer when nothing was ever queued", async () => {
    if (!TEST_DB) return;
    const out = await page("/queue");
    expect(out).toContain("Nothing queued yet");
    expect(out).toContain('href="/compose"');
  });
});

describe("queue attention band", () => {
  it("appears only when something needs a reaction, with a breakdown, and those posts stay out of the sections", async () => {
    if (!TEST_DB) return;
    expect(await page("/queue")).not.toContain("need your attention");
    await seed({ status: "scheduled", at: new Date(Date.now() + HOUR), caption: "fine" });
    expect(await page("/queue")).not.toContain("need your attention");
    await seed({ status: "failed", caption: "failed one", lastError: "Token expired" });
    await seed({ status: "failed", caption: "failed two" });
    await seed({ status: "held", caption: "held one" });
    await seed({ status: "unknown", caption: "unknown one" });
    const out = await page("/queue");
    expect(out).toContain("4 posts need your attention");
    expect(out).toContain("2 failed · 1 held · 1 unknown");
    expect(out).toContain("/queue?status=attention");
    for (const name of ["scheduled", "published", "canceled"] as const) expect(section(out, name)).not.toContain("failed one");
  });

  it("Review lists the problem posts with the reason and a way to act on them", async () => {
    if (!TEST_DB) return;
    const failed = await seed({ status: "failed", caption: "failed one", lastError: "Token expired" });
    const held = await seed({ status: "held", caption: "held one" });
    const out = await page("/queue?status=attention");
    expect(out).toContain("Token expired");
    expect(out).toContain(`/queue/${failed}/retry`);
    expect(out).toContain(`/queue/${held}/cancel`);
    expect(rowCount(out)).toBe(2);
  });
});

describe("queue days", () => {
  // 23:30 UTC on the 2nd is 00:30 on the 3rd in Warsaw (UTC+1 in January).
  const lateUtc = new Date(Date.UTC(new Date().getUTCFullYear() + 1, 0, 2, 23, 30));
  const nextYear = lateUtc.getUTCFullYear();

  it("groups by the viewer's calendar day and time zone, not UTC", async () => {
    if (!TEST_DB) return;
    await seed({ status: "scheduled", at: lateUtc, caption: "late" });
    await seed({ status: "scheduled", at: new Date(lateUtc.getTime() - 2 * HOUR), caption: "earlier" });
    const warsaw = section(await page("/queue", "ps_tz=Europe/Warsaw"), "scheduled");
    expect(warsaw).toContain(`day=${nextYear}-01-02`);
    expect(warsaw).toContain(`day=${nextYear}-01-03`);
    expect(warsaw).toContain(">00:30<");
    expect(warsaw).toContain(">22:30<");
    const utc = section(await page("/queue"), "scheduled");
    expect(utc).toContain(`day=${nextYear}-01-02`);
    expect(utc).not.toContain(`day=${nextYear}-01-03`);
    expect(utc).toContain(">23:30<");
  });

  it("an unknown time zone falls back to UTC instead of failing", async () => {
    if (!TEST_DB) return;
    await seed({ status: "scheduled", at: lateUtc, caption: "late" });
    for (const tz of ["Mars/Olympus", "+01:00", "'; drop table deliveries; --"]) {
      const res = await app.request("/queue", { headers: { cookie: `${cookie}; ps_tz=${encodeURIComponent(tz)}` } });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain(">23:30<");
    }
  });

  it("a day chip narrows Scheduled to that local day and leaves the other sections alone", async () => {
    if (!TEST_DB) return;
    await seed({ status: "scheduled", at: lateUtc, caption: "on the third" });
    await seed({ status: "scheduled", at: new Date(lateUtc.getTime() - 2 * HOUR), caption: "on the second" });
    await seed({ status: "sent", caption: "already out" });
    const out = await page(`/queue?day=${nextYear}-01-03`, "ps_tz=Europe/Warsaw");
    const scheduled = section(out, "scheduled");
    expect(scheduled).toContain("on the third");
    expect(scheduled).not.toContain("on the second");
    expect(section(out, "published")).toContain("already out");
    expect((await app.request("/queue?day=garbage", { headers: { cookie } })).status).toBe(200);
  });

  it("day boundaries follow the zone across a clock change", async () => {
    if (!TEST_DB) return;
    // Warsaw's late-March change makes that day 23 hours long: 23:00 UTC on Saturday to 22:00 UTC on Sunday.
    const sunday = new Date(Date.UTC(nextYear, 2, 31));
    sunday.setUTCDate(31 - sunday.getUTCDay());
    const day = sunday.toISOString().slice(0, 10);
    const before = new Date(sunday.getTime() - 90 * 60_000);
    const inside = new Date(sunday.getTime() - 30 * 60_000);
    const lastMinute = new Date(sunday.getTime() + 21 * HOUR + 59 * 60_000);
    const outside = new Date(sunday.getTime() + 22 * HOUR + 60_000);
    await seed({ status: "scheduled", at: before, caption: "previous day" });
    await seed({ status: "scheduled", at: inside, caption: "first hour" });
    await seed({ status: "scheduled", at: lastMinute, caption: "last minute" });
    await seed({ status: "scheduled", at: outside, caption: "next day" });
    const scheduled = section(await page(`/queue?day=${day}`, "ps_tz=Europe/Warsaw"), "scheduled");
    expect(scheduled).toContain("first hour");
    expect(scheduled).toContain("last minute");
    expect(scheduled).not.toContain("next day");
    expect(scheduled).not.toContain("previous day");
  });
});

describe("queue full list", () => {
  it("walks every scheduled post soonest first and back again, also with identical times", async () => {
    if (!TEST_DB) return;
    const same = new Date(Date.now() + HOUR);
    await seedMany(120, "scheduled", () => same);
    const seen: string[] = [];
    let path: string | null = "/queue?status=scheduled";
    const ids = (out: string) => [...out.matchAll(/data-row="([^"]+)"/g)].map((m) => m[1]!);
    const hops: string[] = [];
    while (path) {
      const out: string = await page(path);
      seen.push(...ids(out));
      hops.push(path);
      const next: RegExpMatchArray | null = out.match(/rel="next" href="([^"]+)"/);
      path = next ? next[1]!.replaceAll("&amp;", "&") : null;
    }
    expect(new Set(seen).size).toBe(120);
    expect(seen).toHaveLength(120);
    const back = await page(hops[1]!);
    const prev = back.match(/rel="prev" href="([^"]+)"/)![1]!.replaceAll("&amp;", "&");
    expect(ids(await page(prev))).toEqual(seen.slice(0, 50));
  });

  it("names the pager by time direction and orders by it", async () => {
    if (!TEST_DB) return;
    await seed({ status: "scheduled", at: new Date(Date.now() + 2 * DAY), caption: "later one" });
    await seed({ status: "scheduled", at: new Date(Date.now() + DAY), caption: "sooner one" });
    const scheduled = await page("/queue?status=scheduled");
    expect(ascending(order(scheduled, ["sooner one", "later one"]))).toBe(true);
    expect(scheduled).toContain("Later");
    expect(scheduled).toContain("Earlier");
    await seed({ status: "sent", at: new Date(Date.now() - 2 * DAY), caption: "old one" });
    await seed({ status: "sent", at: new Date(Date.now() - DAY), caption: "new one" });
    const published = await page("/queue?status=published");
    expect(ascending(order(published, ["new one", "old one"]))).toBe(true);
    expect(published).toContain("Older");
    expect(published).not.toContain("sooner one");
  });

  it("chips count each section, and All goes back to the sections view", async () => {
    if (!TEST_DB) return;
    await seedMany(3, "sent", () => new Date());
    await seed({ status: "failed" });
    const out = await page("/queue?status=published");
    expect(out).toMatch(/Published <b>3<\/b>/);
    expect(out).toMatch(/Needs attention <b>1<\/b>/);
    expect(out).toMatch(/href="\/queue"[^>]*>All <b>4<\/b>/);
  });

  it("an unknown status value shows the sections view", async () => {
    if (!TEST_DB) return;
    await seed({ status: "sent", caption: "still here" });
    expect(section(await page("/queue?status=nope"), "published")).toContain("still here");
  });
});

describe("queue post panel", () => {
  it("offers editing, rescheduling, publish now and cancel for a scheduled post", async () => {
    if (!TEST_DB) return;
    const id = await seed({ status: "scheduled", at: new Date(Date.now() + HOUR), caption: "Editable <text>" });
    const out = await page(`/queue?open=${id}`);
    expect(out).toContain("dl-detail");
    expect(out).toMatch(/<textarea[^>]*name="text"[^>]*>Editable &lt;text&gt;<\/textarea>/);
    for (const verb of ["text", "reschedule", "publish-now", "cancel"]) expect(out).toContain(`/queue/${id}/${verb}`);
  });

  it("is read-only for a published post and shows what happened", async () => {
    if (!TEST_DB) return;
    const id = await seed({ status: "sent", caption: "Out already", lastError: "Earlier hiccup" });
    await db.update(deliveries).set({ attempts: 2, provider_handle: "https://example.test/p/1" }).where(eq(deliveries.id, id));
    const out = await page(`/queue?open=${id}`);
    expect(out).not.toContain(`<textarea`);
    expect(out).toContain("Out already");
    expect(out).toContain("2/5");
    expect(out).toContain("https://example.test/p/1");
    expect(out).not.toContain(`/queue/${id}/cancel`);
    expect(out).toContain(`href="/queue/${id}"`);
  });

  it("leaves TikTok settings review as the only path for a post waiting on it", async () => {
    if (!TEST_DB) return;
    const ch = await addChannel(workspaceId, "Clips", "tiktok");
    const id = await seed({ status: "held", channel: ch, format: "video", caption: "Needs review" });
    await db.update(deliveries).set({ tiktok_confirmation: "required" }).where(eq(deliveries.id, id));
    const out = await page(`/queue?open=${id}`);
    expect(out).toContain(`/queue/${id}/confirm`);
    expect(out).not.toContain(`/queue/${id}/publish-now`);
    expect(out).not.toContain(`/queue/${id}/reschedule`);
    expect(out).not.toContain("<textarea");
    expect(out).toContain(`/queue/${id}/cancel`);
  });

  it("returns 404 for a malformed or unknown row id", async () => {
    if (!TEST_DB) return;
    await seed({ status: "sent" });
    for (const open of ["nope", "00000000-0000-4000-8000-000000000000"]) {
      const res = await app.request(`/queue?open=${open}`, { headers: { cookie } });
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain("dl-detail");
    }
  });

  it("technical details never print tokens", async () => {
    if (!TEST_DB) return;
    const id = await seed({ status: "sent" });
    await db.update(deliveries).set({ payload: { format: "text", media: [], caption: "x", options: { access_token: "tok-should-not-show" } } }).where(eq(deliveries.id, id));
    expect(await page(`/queue?open=${id}`)).not.toContain("tok-should-not-show");
  });
});

describe("queue actions keep the list in place", () => {
  it("publish now, cancel, retry and reschedule return the list for the address the viewer is on", async () => {
    if (!TEST_DB) return;
    await seed({ status: "sent", caption: "Filtered out", format: "image" });
    const at = new Date(Date.now() + 2 * HOUR);
    const now = await seed({ status: "scheduled", at, caption: "A row" });
    const cancel = await seed({ status: "scheduled", at, caption: "B row" });
    const retry = await seed({ status: "failed", caption: "C row" });
    const move = await seed({ status: "scheduled", at, caption: "D row" });
    const url = `/queue?format=text&show_published=26&open=${cancel}`;
    const post = (id: string, verb: string, body = "") => app.request(`/queue/${id}/${verb}`, { method: "POST", headers: htmx(url), body });

    for (const [id, verb, body] of [[now, "publish-now", ""], [cancel, "cancel", ""], [retry, "retry", ""], [move, "reschedule", new URLSearchParams({ scheduledAt: new Date(Date.now() + DAY).toISOString() }).toString()]] as const) {
      const res = await post(id, verb, body);
      expect(res.status, verb).toBe(200);
      const out = await res.text();
      expect(out, verb).toContain('id="data-list"');
      expect(out, verb).not.toContain("<!doctype");
      expect(out, verb).not.toContain("Filtered out");
      expect(out, verb).toContain("show_published=26");
      expect(out, verb).toContain("dl-detail");
    }
    const status = async (id: string) => (await db.query.deliveries.findFirst({ where: eq(deliveries.id, id) }))!.status;
    expect(await status(cancel)).toBe("canceled");
    expect(await status(retry)).toBe("scheduled");
    expect((await db.query.deliveries.findFirst({ where: eq(deliveries.id, now) }))!.scheduled_at.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("a canceled post moves to Canceled in the returned list", async () => {
    if (!TEST_DB) return;
    const id = await seed({ status: "scheduled", at: new Date(Date.now() + HOUR), caption: "Moved row" });
    const out = await (await app.request(`/queue/${id}/cancel`, { method: "POST", headers: htmx("/queue") })).text();
    expect(section(out, "canceled")).toContain("Moved row");
    expect(section(out, "scheduled")).not.toContain("Moved row");
  });

  it("the full post page keeps working with its own header swap", async () => {
    if (!TEST_DB) return;
    const id = await seed({ status: "scheduled", at: new Date(Date.now() + HOUR) });
    const res = await app.request(`/queue/${id}/cancel`, { method: "POST", headers: { ...htmx(`/queue/${id}`), "HX-Target": "post-detail-head" } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('id="post-detail-head"');
  });
});

describe("queue edit text", () => {
  const edit = (id: string, text: string, headers: Record<string, string> = htmx("/queue")) =>
    app.request(`/queue/${id}/text`, { method: "POST", headers, body: new URLSearchParams({ text }).toString() });
  const row = async (id: string) => (await db.query.deliveries.findFirst({ where: eq(deliveries.id, id) }))!;
  const caption = (d: { payload: unknown }) => (d.payload as { caption?: string }).caption;

  it("changes what will be published for a post without an editorial record", async () => {
    if (!TEST_DB) return;
    const li = await addChannel(workspaceId, "Company page", "linkedin");
    const id = await seed({ status: "scheduled", channel: li, at: new Date(Date.now() + HOUR), caption: "Price 90" });
    const res = await edit(id, "Price 99");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.headers.get("HX-Trigger")!)["ps:toast"].msg).toBe("Text saved.");
    expect(caption(await row(id))).toBe("Price 99");
    expect((await res.text())).toContain("Price 99");
  });

  it("updates the editorial post and the payload together, keeping hashtags and options", async () => {
    if (!TEST_DB) return;
    const li = await addChannel(workspaceId, "Company page", "linkedin");
    const id = await seed({ status: "held", channel: li, at: new Date(Date.now() + HOUR), caption: "Old\n\n#tag" });
    await db.update(deliveries).set({ payload: { format: "text", media: [], caption: "Old\n\n#tag", options: { firstComment: "Keep me" } } }).where(eq(deliveries.id, id));
    const [post] = await db.insert(posts).values({ workspace_id: workspaceId, platform: "linkedin", status: "scheduled", delivery_id: id, description: "Old", hashtags: "#tag" }).returning();
    const res = await edit(id, "New");
    expect(res.status).toBe(200);
    const after = await row(id);
    expect(caption(after)).toBe("New\n\n#tag");
    expect((after.payload as { options: { firstComment: string } }).options.firstComment).toBe("Keep me");
    expect(after.status).toBe("held");
    const api = (await (await app.request(`/api/v1/posts/${post!.id}`, { headers: { cookie } })).json()).data;
    expect(api.description).toBe("New");
    const panel = await page(`/queue?open=${id}`);
    expect(panel).toMatch(/<textarea[^>]*>New<\/textarea>/);
    expect(panel).toContain("#tag");
    await db.delete(posts).where(eq(posts.id, post!.id));
  });

  it("refuses once the post is on its way or done", async () => {
    if (!TEST_DB) return;
    for (const status of ["sending", "processing", "sent", "failed", "canceled"] as const) {
      const id = await seed({ status, caption: "Frozen" });
      const res = await edit(id, "Changed");
      expect(res.status, status).toBe(409);
      expect(caption(await row(id)), status).toBe("Frozen");
    }
    const id = await seed({ status: "sending", caption: "Frozen" });
    const [post] = await db.insert(posts).values({ workspace_id: workspaceId, platform: "facebook", status: "publishing", delivery_id: id, description: "Frozen" }).returning();
    expect((await edit(id, "Changed")).status).toBe(409);
    expect((await db.query.posts.findFirst({ where: eq(posts.id, post!.id) }))!.description).toBe("Frozen");
    await db.delete(posts).where(eq(posts.id, post!.id));
  });

  it("refuses a post waiting for TikTok settings review", async () => {
    if (!TEST_DB) return;
    const ch = await addChannel(workspaceId, "Clips", "tiktok");
    const id = await seed({ status: "held", channel: ch, format: "video", caption: "Review me" });
    await db.update(deliveries).set({ tiktok_confirmation: "required" }).where(eq(deliveries.id, id));
    expect((await edit(id, "Changed")).status).toBe(409);
    expect(caption(await row(id))).toBe("Review me");
  });

  it("rejects text the platform cannot publish and leaves the post as it was", async () => {
    if (!TEST_DB) return;
    const li = await addChannel(workspaceId, "Company page", "linkedin");
    const id = await seed({ status: "scheduled", channel: li, at: new Date(Date.now() + HOUR), caption: "Fine" });
    const res = await edit(id, "   ");
    expect(res.status).toBe(422);
    expect(caption(await row(id))).toBe("Fine");
  });

  it("another workspace's post is not found and stays untouched", async () => {
    if (!TEST_DB) return;
    const [other] = await db.insert(workspaces).values({ name: "Other", slug: `other-${Math.random().toString(36).slice(2)}` }).returning();
    const ch = await addChannel(other!.id, "Foreign");
    const id = await seed({ ws: other!.id, channel: ch, status: "scheduled", caption: "Theirs" });
    expect((await edit(id, "Mine")).status).toBe(404);
    expect(caption(await row(id))).toBe("Theirs");
    await db.delete(workspaces).where(eq(workspaces.id, other!.id));
  });

  it("without a session it does nothing", async () => {
    if (!TEST_DB) return;
    const id = await seed({ status: "scheduled", at: new Date(Date.now() + HOUR), caption: "Safe" });
    const res = await edit(id, "Changed", { "content-type": "application/x-www-form-urlencoded" });
    expect(res.status).toBe(302);
    expect(caption(await row(id))).toBe("Safe");
  });
});

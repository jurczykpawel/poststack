import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import type { Hono } from "hono";
import { eq } from "drizzle-orm";

const TEST_DB = process.env.TEST_DATABASE_URL;

let app: Hono;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let cookie: string;

const WS = "eeeeeeee-0000-4000-8000-0000000000a1";
const OTHER_WS = "eeeeeeee-0000-4000-8000-0000000000b1";
const USER = "eeeeeeee-0000-4000-8000-0000000000a2";

// The events list lives at /activity?source=events since UXFLOW1 stage 3; the paths below stay short.
const get = async (path: string) => {
  const res = await app.request(path.replace(/^\/events(\?)?/, (_m, q) => `/activity?source=events${q ? "&" : ""}`), { headers: { cookie } });
  expect(res.status).toBe(200);
  return res.text();
};
const rowIds = (body: string) => [...body.matchAll(/data-row="([0-9a-f-]{36})"/g)].map((m) => m[1]!);
const decode = (href: string) => href.replace(/&amp;/g, "&");
const link = (body: string, rel: "next" | "prev") => {
  const m = new RegExp(`<a[^>]*rel="${rel}"[^>]*href="([^"]+)"|<a[^>]*href="([^"]+)"[^>]*rel="${rel}"`).exec(body);
  return m ? decode((m[1] ?? m[2])!) : null;
};
const chipCount = (body: string, label: string) => {
  const m = new RegExp(`class="dl-chip[^"]*"[^>]*>\\s*${label}\\s*<b>([\\d,]+)</b>`).exec(body);
  return m ? Number(m[1]!.replace(/,/g, "")) : null;
};

async function seed(rows: Array<Partial<typeof import("@/db/schema").events.$inferInsert>>, workspace = WS) {
  return db.insert(s.events).values(rows.map((r) => ({ workspace_id: workspace, type: "post.published", ...r }))).returning({ id: s.events.id });
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
  await db.insert(s.workspaces).values([{ id: WS, name: "E", slug: `e-${WS}` }, { id: OTHER_WS, name: "O", slug: `o-${OTHER_WS}` }]);
  await db.insert(s.workspaceMembers).values({ workspace_id: WS, user_id: USER, role: "owner" });
});

describe("events source of /activity", () => {
  it("reaches every row exactly once going older, and the same pages going newer, across equal timestamps", async () => {
    if (!TEST_DB) return;
    const sameMoment = new Date("2026-10-01T10:00:00.000Z");
    await seed(Array.from({ length: 120 }, () => ({ created_at: sameMoment })));

    const first = await get("/events");
    expect(rowIds(first)).toHaveLength(50);
    expect(first).toContain("1–50 of 120");
    expect(link(first, "prev")).toBeNull();

    const secondHref = link(first, "next")!;
    const second = await get(secondHref);
    expect(second).toContain("51–100 of 120");
    const third = await get(link(second, "next")!);
    expect(third).toContain("101–120 of 120");
    expect(link(third, "next")).toBeNull();

    const seen = [...rowIds(first), ...rowIds(second), ...rowIds(third)];
    expect(new Set(seen).size).toBe(120);

    const backToSecond = await get(link(third, "prev")!);
    expect(rowIds(backToSecond)).toEqual(rowIds(second));
    const backToFirst = await get(link(backToSecond, "prev")!);
    expect(rowIds(backToFirst)).toEqual(rowIds(first));
    expect(link(backToFirst, "prev")).toBeNull();
  });

  it("orders newest first", async () => {
    if (!TEST_DB) return;
    const [older] = await seed([{ created_at: new Date("2026-10-01T10:00:00Z") }]);
    const [newer] = await seed([{ created_at: new Date("2026-10-02T10:00:00Z") }]);
    expect(rowIds(await get("/events"))).toEqual([newer!.id, older!.id]);
  });

  it("chips count by severity, honour the other filters, and act as a filter", async () => {
    if (!TEST_DB) return;
    await seed([
      { type: "post.failed", payload: { platform: "instagram" } },
      { type: "channel.needs_reauth", payload: { platform: "facebook" } },
      { type: "post.held", payload: { platform: "instagram" } },
      { type: "post.published", payload: { platform: "instagram" } },
      { type: "contact.created" },
    ]);
    const all = await get("/events");
    expect(chipCount(all, "All")).toBe(5);
    expect(chipCount(all, "Problems")).toBe(2);
    expect(chipCount(all, "Warnings")).toBe(1);
    expect(chipCount(all, "Normal")).toBe(2);

    const narrowed = await get("/events?platform=instagram");
    expect(chipCount(narrowed, "All")).toBe(3);
    expect(chipCount(narrowed, "Problems")).toBe(1);

    // Picking a chip keeps the chips for its siblings, so another severity stays one click away.
    const problems = await get("/events?severity=problems");
    expect(rowIds(problems)).toHaveLength(2);
    expect(chipCount(problems, "Normal")).toBe(2);
    expect(problems).toContain("1–2 of 2");

    const area = await get("/events?area=contact");
    expect(rowIds(area)).toHaveLength(1);
  });

  it("names a platform that has no brand glyph", async () => {
    if (!TEST_DB) return;
    await seed([{ payload: { platform: "telegram" } }]);
    expect(await get("/events")).toContain(">Telegram<");
  });

  it("filter links drop the page position but keep the other filters", async () => {
    if (!TEST_DB) return;
    await seed(Array.from({ length: 60 }, () => ({ type: "post.failed" })));
    const firstPage = await get("/events?platform=instagram&q=post");
    expect(firstPage).toContain("No events match");
    const page1 = await get("/events?q=post");
    const page2Href = link(page1, "next")!;
    expect(page2Href).toContain("q=post");
    const page2 = await get(page2Href);
    const chip = /<a[^>]*class="dl-chip[^"]*"[^>]*href="([^"]+)"[^>]*>\s*Problems/.exec(page2);
    const href = decode(chip![1]!);
    expect(href).toContain("severity=problems");
    expect(href).toContain("q=post");
    expect(href).not.toContain("after=");
  });

  it("searches by friendly label, raw type and subject, treating % literally", async () => {
    if (!TEST_DB) return;
    const [named] = await seed([{ type: "channel.created", payload: { displayName: "Acme 100% IG" } }]);
    const [labelled] = await seed([{ type: "channel.needs_reauth" }]);
    expect(rowIds(await get("/events?q=acme"))).toEqual([named!.id]);
    expect(rowIds(await get("/events?q=" + encodeURIComponent("re-auth")))).toEqual([labelled!.id]);
    expect(rowIds(await get("/events?q=needs_reauth"))).toEqual([labelled!.id]);
    expect(rowIds(await get("/events?q=" + encodeURIComponent("100%")))).toEqual([named!.id]);
    expect(rowIds(await get("/events?q=" + encodeURIComponent("%")))).toEqual([named!.id]);
  });

  it("never shows another workspace's rows, counts or details", async () => {
    if (!TEST_DB) return;
    await seed([{ type: "post.failed" }]);
    const [foreign] = await seed([{ type: "post.failed", payload: { displayName: "Foreign brand", platform: "telegram" } }], OTHER_WS);
    const body = await get(`/events?open=${foreign!.id}`);
    expect(rowIds(body)).toHaveLength(1);
    expect(chipCount(body, "All")).toBe(1);
    expect(body).not.toContain("Foreign brand");
    expect(body).not.toContain(foreign!.id);
    expect(body).not.toContain('value="telegram"');
    expect(body).not.toContain('class="dl-detail');
  });

  it("opens details beside the list, with escaped payload and without contact identities", async () => {
    if (!TEST_DB) return;
    const [ev] = await seed([{
      type: "contact.created", subject_type: "contact", subject_id: "c-1",
      payload: { displayName: "<script>alert(1)</script>", workspaceId: WS, channels: [{ platformSenderId: "PSID-SECRET" }], note: "kept" },
    }]);
    const body = await get(`/events?open=${ev!.id}`);
    expect(body).toContain('class="dl-detail');
    expect(body).toMatch(new RegExp(`data-row="${ev!.id}"[^>]*aria-current="true"|aria-current="true"[^>]*data-row="${ev!.id}"`));
    expect(body).toContain("kept");
    expect(body).not.toContain("<script>alert(1)</script>");
    expect(body).not.toContain("PSID-SECRET");
    expect(body).toContain('href="/activity?source=events"'); // the close link returns to the same list without `open`
  });

  it("links a conversation event to its conversation, outside the list swap", async () => {
    if (!TEST_DB) return;
    const conversationId = "eeeeeeee-0000-4000-8000-0000000000c1";
    const [ev] = await seed([{ type: "conversation.updated", subject_type: "conversation", subject_id: conversationId }]);
    const body = await get(`/events?open=${ev!.id}`);
    expect(body).toContain(`href="/inbox/${conversationId}"`);
    expect(body).toMatch(/hx-boost="false"[\s\S]*\/inbox\//);
  });

  it("survives hand-edited URLs by falling back to the plain list", async () => {
    if (!TEST_DB) return;
    await seed([{ type: "post.failed" }]);
    for (const qs of ["after=garbage", "before=%00", "open=not-a-uuid", "severity=nonsense", "area=" + encodeURIComponent("'; DROP TABLE events; --")]) {
      const body = await get(`/events?${qs}`);
      expect(body, qs).not.toContain('class="dl-detail');
    }
    expect(rowIds(await get("/events?after=garbage"))).toHaveLength(1);
    expect(rowIds(await get("/events?severity=nonsense"))).toHaveLength(1);
  });

  it("returns to the first page when the cursor points past rows pruned since the link was made", async () => {
    if (!TEST_DB) return;
    await seed(Array.from({ length: 60 }, () => ({})));
    const next = link(await get("/events"), "next")!;
    const { encodeCursor } = await import("@/lib/api/pagination");
    await db.delete(s.events).where(eq(s.events.workspace_id, WS));
    await seed([{}, {}]);
    const stale = await get(next);
    expect(rowIds(stale)).toHaveLength(2);
    expect(stale).toContain("1–2 of 2");
    const ancient = encodeCursor({ createdAt: "2000-01-01T00:00:00.000Z", id: WS });
    expect(rowIds(await get(`/events?after=${ancient}`))).toHaveLength(2);
  });

  it("explains an empty log differently from an empty filter result", async () => {
    if (!TEST_DB) return;
    expect(await get("/events")).toContain("No events yet");
    await seed([{}]);
    const none = await get("/events?q=zzz-nothing");
    expect(none).toContain("No events match");
    expect(none).not.toContain("No events yet");
  });

  describe("inbound message / comment rows (ACTEVT1)", () => {
    const CH = "eeeeeeee-0000-4000-8000-0000000000c1";
    const CONTACT = "eeeeeeee-0000-4000-8000-0000000000c2";
    const CONV = "eeeeeeee-0000-4000-8000-0000000000c3";
    const base = async () => {
      await db.insert(s.channels).values({ id: CH, workspace_id: WS, platform: "youtube", platform_id: "yt1", display_name: "My channel", token_encrypted: "x", webhook_secret: "x" });
      await db.insert(s.contacts).values({ id: CONTACT, workspace_id: WS, display_name: "Ann <b>Lee</b>" });
      await db.insert(s.conversations).values({ id: CONV, workspace_id: WS, channel_id: CH, contact_id: CONTACT, platform: "youtube" });
    };

    it("shows contact, channel and an escaped text snippet from our own tables, linking to the conversation", async () => {
      if (!TEST_DB) return;
      await base();
      const [m] = await db.insert(s.messages).values({ conversation_id: CONV, direction: "inbound", text: "hello <script>x</script> there" }).returning({ id: s.messages.id });
      const [c] = await db.insert(s.commentLogs).values({ workspace_id: WS, channel_id: CH, platform_comment_id: "pc1", author_name: "Bob", comment_text: "great <i>video</i>", conversation_id: CONV, post_url: "https://youtu.be/abc" }).returning({ id: s.commentLogs.id });
      const [em, ec] = await seed([
        { type: "message.received", subject_type: "message", subject_id: m!.id, payload: { platform: "youtube" } },
        { type: "comment.received", subject_type: "comment", subject_id: c!.id, payload: { platform: "youtube" } },
      ]);
      const list = await get("/events");
      expect(list).toContain("Ann &lt;b&gt;Lee&lt;/b&gt;");
      expect(list).toContain("hello &lt;script&gt;x&lt;/script&gt; there");
      expect(list).toContain("My channel");
      expect(list).toContain("great &lt;i&gt;video&lt;/i&gt;");
      expect(list).not.toContain("<script>x</script>");
      expect(list).not.toContain(`message · ${m!.id}`);
      const detail = await get(`/events?open=${ec!.id}`);
      expect(detail).toContain(`href="/inbox/${CONV}"`);
      expect(detail).toContain("https://youtu.be/abc");
      expect(await get(`/events?open=${em!.id}`)).toContain(`href="/inbox/${CONV}"`);
    });

    it("shows a dash, not an error, when the row is gone, and never reads another workspace's row", async () => {
      if (!TEST_DB) return;
      await base();
      const otherCh = "eeeeeeee-0000-4000-8000-0000000000d1";
      await db.insert(s.channels).values({ id: otherCh, workspace_id: OTHER_WS, platform: "youtube", platform_id: "yt2", token_encrypted: "x", webhook_secret: "x" });
      const [foreign] = await db.insert(s.commentLogs).values({ workspace_id: OTHER_WS, channel_id: otherCh, platform_comment_id: "pc2", comment_text: "SECRET-OTHER" }).returning({ id: s.commentLogs.id });
      const gone = "eeeeeeee-0000-4000-8000-0000000000e1";
      const [a, b] = await seed([
        { type: "comment.received", subject_type: "comment", subject_id: gone },
        { type: "comment.received", subject_type: "comment", subject_id: foreign!.id },
      ]);
      const list = await get("/events");
      expect(rowIds(list).sort()).toEqual([a!.id, b!.id].sort());
      expect(list).not.toContain("SECRET-OTHER");
      expect(list).not.toContain(gone);
      const detail = await get(`/events?open=${a!.id}`);
      expect(detail).not.toContain("Open conversation");
    });
  });
});

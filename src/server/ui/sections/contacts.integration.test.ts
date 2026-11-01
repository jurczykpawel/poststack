import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import { licenseInstance } from "@/lib/license/__fixtures__/license-instance";

const TEST_DB = process.env.TEST_DATABASE_URL;

let app: Hono;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let cookie: string;

const WS = "cccccccc-0000-4000-8000-0000000000a1";
const OTHER_WS = "cccccccc-0000-4000-8000-0000000000b1";
const USER = "cccccccc-0000-4000-8000-0000000000a2";
const CH = "cccccccc-0000-4000-8000-0000000000c1";
const CH_IG = "cccccccc-0000-4000-8000-0000000000c2";

const get = async (path: string) => {
  const res = await app.request(path, { headers: { cookie } });
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

async function seed(rows: Array<Partial<typeof import("@/db/schema").contacts.$inferInsert>>, workspace = WS) {
  return db.insert(s.contacts).values(rows.map((r) => ({ workspace_id: workspace, display_name: "Person", ...r }))).returning({ id: s.contacts.id });
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
  await licenseInstance();
  const { signSession } = await import("@/lib/auth");
  cookie = `session=${await signSession(USER, WS)}`;
});

beforeEach(async () => {
  if (!TEST_DB) return;
  for (const id of [WS, OTHER_WS]) await db.delete(s.workspaces).where(eq(s.workspaces.id, id));
  await db.delete(s.users).where(eq(s.users.id, USER));
  await db.insert(s.users).values({ id: USER, email: `u-${USER}@test.local` });
  await db.insert(s.workspaces).values([{ id: WS, name: "C", slug: `c-${WS}` }, { id: OTHER_WS, name: "O", slug: `o-${OTHER_WS}` }]);
  await db.insert(s.workspaceMembers).values({ workspace_id: WS, user_id: USER, role: "owner" });
  await db.insert(s.channels).values([
    { id: CH, workspace_id: WS, platform: "facebook", platform_id: "FB-C", display_name: "FB Shop", token_encrypted: "x", webhook_secret: "s1", status: "active" },
    { id: CH_IG, workspace_id: WS, platform: "instagram", platform_id: "IG-C", display_name: "IG Shop", token_encrypted: "x", webhook_secret: "s2", status: "active" },
  ]);
});

describe("/contacts list", () => {
  it("reaches every row once, newest activity first, NULL activity last, in both directions", async () => {
    if (!TEST_DB) return;
    const tie = new Date("2026-10-01T10:00:00.000Z");
    // 70 rows share one moment, 60 have never interacted: pages straddle the tie and the NULL group.
    await seed([
      ...Array.from({ length: 70 }, () => ({ last_interaction_at: tie })),
      ...Array.from({ length: 60 }, () => ({ last_interaction_at: null })),
    ]);
    const [newest] = await seed([{ last_interaction_at: new Date("2026-10-02T10:00:00Z") }]);

    const p1 = await get("/contacts");
    expect(rowIds(p1)[0]).toBe(newest!.id);
    expect(p1).toContain("1–50 of 131");
    expect(link(p1, "prev")).toBeNull();
    const p2 = await get(link(p1, "next")!);
    expect(p2).toContain("51–100 of 131");
    const p3 = await get(link(p2, "next")!);
    expect(p3).toContain("101–131 of 131");
    expect(link(p3, "next")).toBeNull();

    const seen = [...rowIds(p1), ...rowIds(p2), ...rowIds(p3)];
    expect(new Set(seen).size).toBe(131);

    const back2 = await get(link(p3, "prev")!);
    expect(rowIds(back2)).toEqual(rowIds(p2));
    const back1 = await get(link(back2, "prev")!);
    expect(rowIds(back1)).toEqual(rowIds(p1));
    expect(link(back1, "prev")).toBeNull();
  });

  it("pages through a list made only of never-interacted contacts", async () => {
    if (!TEST_DB) return;
    await seed(Array.from({ length: 60 }, () => ({ last_interaction_at: null })));
    const p1 = await get("/contacts");
    const p2 = await get(link(p1, "next")!);
    expect(new Set([...rowIds(p1), ...rowIds(p2)]).size).toBe(60);
    expect(rowIds(await get(link(p2, "prev")!))).toEqual(rowIds(p1));
  });

  it("is scoped to the workspace and escapes LIKE wildcards in search", async () => {
    if (!TEST_DB) return;
    await seed([{ display_name: "100% Alice" }, { display_name: "1000 Alex" }, { display_name: "Third" }], WS);
    await seed([{ display_name: "100% Other workspace" }], OTHER_WS);
    const body = await get("/contacts?q=100%25");
    expect(body).toContain("100% Alice");
    expect(body).not.toContain("1000 Alex");
    expect(body).not.toContain("Other workspace");
    expect(await get("/contacts")).toContain("1–3 of 3");
  });

  it("finds a contact by channel handle, filters by platform and brand, and counts subscription chips", async () => {
    if (!TEST_DB) return;
    await db.insert(s.brands).values({ workspace_id: WS, key: "acme", name: "Acme" });
    await db.update(s.channels).set({ brand_key: "acme" }).where(eq(s.channels.id, CH_IG));
    const [fb, ig, gone] = await seed([{ display_name: "Fb Fan" }, { display_name: "Ig Fan" }, { display_name: "Gone Fan", is_subscribed: false }]);
    await db.insert(s.contactChannels).values([
      { contact_id: fb!.id, channel_id: CH, platform_sender_id: "S1", platform_username: "fbfan" },
      { contact_id: ig!.id, channel_id: CH_IG, platform_sender_id: "S2", platform_username: "igfan_handle" },
      { contact_id: gone!.id, channel_id: CH, platform_sender_id: "S3" },
    ]);
    expect(rowIds(await get("/contacts?q=igfan_h"))).toEqual([ig!.id]);
    expect(rowIds(await get("/contacts?platform=instagram"))).toEqual([ig!.id]);
    expect(rowIds(await get("/contacts?brand=acme"))).toEqual([ig!.id]);
    expect(rowIds(await get(`/contacts?channel=${CH}`)).sort()).toEqual([fb!.id, gone!.id].sort());

    const all = await get("/contacts");
    expect(chipCount(all, "All")).toBe(3);
    expect(chipCount(all, "Subscribed")).toBe(2);
    expect(chipCount(all, "Unsubscribed")).toBe(1);
    expect(rowIds(await get("/contacts?status=unsubscribed"))).toEqual([gone!.id]);
    // A chip keeps its siblings' counts under the other filters.
    expect(chipCount(await get("/contacts?platform=facebook"), "All")).toBe(2);
  });

  it("filters by tag", async () => {
    if (!TEST_DB) return;
    const [a, b] = await seed([{ display_name: "Tagged" }, { display_name: "Plain" }]);
    const [tag] = await db.insert(s.tags).values({ workspace_id: WS, name: "vip" }).returning({ id: s.tags.id });
    await db.insert(s.contactTags).values({ contact_id: a!.id, tag_id: tag!.id });
    expect(rowIds(await get("/contacts?tag=vip"))).toEqual([a!.id]);
    expect(b).toBeTruthy();
  });

  it("opens a contact in the panel with channels, tags and an inbox link, and ignores foreign or malformed ids", async () => {
    if (!TEST_DB) return;
    const [mine] = await seed([{ display_name: "Panel Person", email: "panel@example.com", phone: "+48123", last_interaction_at: new Date() }]);
    const [foreign] = await seed([{ display_name: "Foreign Person" }], OTHER_WS);
    await db.insert(s.contactChannels).values({ contact_id: mine!.id, channel_id: CH, platform_sender_id: "PS1", platform_username: "panelp" });
    const [tag] = await db.insert(s.tags).values({ workspace_id: WS, name: "lead" }).returning({ id: s.tags.id });
    await db.insert(s.contactTags).values({ contact_id: mine!.id, tag_id: tag!.id });

    const open = await get(`/contacts?open=${mine!.id}`);
    expect(open).toContain('class="dl-detail"');
    for (const text of ["panel@example.com", "+48123", "@panelp", "lead", `/inbox?contact=${mine!.id}`]) expect(open).toContain(text);
    expect(open).not.toContain("PS1"); // platform sender ids are not shown

    const foreignOpen = await get(`/contacts?open=${foreign!.id}`);
    expect(foreignOpen).not.toContain("Foreign Person");
    expect(foreignOpen).not.toContain('class="dl-detail"');
    const broken = await get("/contacts?open=not-a-uuid&after=%25%25&channel=nope&platform=nope");
    expect(broken).toContain("Panel Person"); // bad cursor and filters fall back to the plain first page
    expect(broken).not.toContain('class="dl-detail"');
  });

  it("no longer serves the old htmx fragment route", async () => {
    if (!TEST_DB) return;
    expect((await app.request("/contacts/list", { headers: { cookie } })).status).toBe(404);
  });
});

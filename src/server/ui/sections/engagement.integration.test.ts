import { describe, it, expect, afterAll, beforeAll, beforeEach } from "vitest";
import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import { seedEngagement, clearEngagement, ENGAGEMENT_BIG_TOTAL } from "../../../../tests/fixtures/engagement";
import { licenseInstance } from "@/lib/license/__fixtures__/license-instance";

const TEST_DB = process.env.TEST_DATABASE_URL;

let app: Hono;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let cookie: string;

const WS = "e6e6e6e6-0000-4000-8000-0000000000a1";
const OTHER_WS = "e6e6e6e6-0000-4000-8000-0000000000b1";
const USER = "e6e6e6e6-0000-4000-8000-0000000000a2";
const CH = "e6e6e6e6-0000-4000-8000-0000000000c1";
const CH2 = "e6e6e6e6-0000-4000-8000-0000000000c2";
const OTHER_CH = "e6e6e6e6-0000-4000-8000-0000000000c3";

const get = async (path: string) => {
  const res = await app.request(path, { headers: { cookie } });
  expect(res.status).toBe(200);
  return res.text();
};
const decode = (href: string) => href.replace(/&amp;/g, "&");
const rowIds = (body: string) => [...body.matchAll(/data-row="([^"]+)"/g)].map((m) => decode(m[1]!));
const link = (body: string, rel: "next" | "prev") => {
  const m = new RegExp(`<a[^>]*rel="${rel}"[^>]*href="([^"]+)"|<a[^>]*href="([^"]+)"[^>]*rel="${rel}"`).exec(body);
  return m ? decode((m[1] ?? m[2])!) : null;
};
const at = (minutesAgo: number) => new Date(Date.UTC(2026, 9, 1, 12, 0, 0) - minutesAgo * 60_000);

/** Facebook's reaction webhook names the post "<page>_<post>" (see meta-api-contract.test.ts). */
const reaction = (post: string, reactor: string, type = "like", created = at(0), channel = CH, workspace = WS) => ({
  workspace_id: workspace, channel_id: channel, post_id: post, reactor_id: reactor, reactor_name: `Name ${reactor}`, reaction_type: type, created_at: created,
});

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
  await licenseInstance();
  for (const id of [WS, OTHER_WS]) await db.delete(s.workspaces).where(eq(s.workspaces.id, id));
  await db.delete(s.users).where(eq(s.users.id, USER));
  await db.insert(s.users).values({ id: USER, email: `u-${USER}@test.local` });
  await db.insert(s.workspaces).values([{ id: WS, name: "E", slug: `e-${WS}` }, { id: OTHER_WS, name: "O", slug: `o-${OTHER_WS}` }]);
  await db.insert(s.workspaceMembers).values({ workspace_id: WS, user_id: USER, role: "owner" });
  await db.insert(s.brands).values({ workspace_id: WS, key: "acme", name: "Acme" });
  await db.insert(s.channels).values([
    { id: CH, workspace_id: WS, platform: "facebook", platform_id: "PG1", display_name: "Acme Page", brand_key: "acme", token_encrypted: "x", webhook_secret: "a", status: "active" },
    { id: CH2, workspace_id: WS, platform: "instagram", platform_id: "IG1", display_name: "Studio IG", token_encrypted: "x", webhook_secret: "b", status: "active" },
    { id: OTHER_CH, workspace_id: OTHER_WS, platform: "facebook", platform_id: "PG9", display_name: "Foreign Page", token_encrypted: "x", webhook_secret: "c", status: "active" },
  ]);
});

// The oldest user is the instance operator, so a user left behind changes what other files see on /settings.
afterAll(async () => {
  if (!TEST_DB) return;
  for (const id of [WS, OTHER_WS]) await db.delete(s.workspaces).where(eq(s.workspaces.id, id));
  await db.delete(s.users).where(eq(s.users.id, USER));
  await db.delete(s.instanceLicense);
});

describe("/engagement post view", () => {
  it("shows the text of our published post, with a way back to it", async () => {
    if (!TEST_DB) return;
    const [ct] = await db.insert(s.content).values({ workspace_id: WS, title: "Spring launch" }).returning({ id: s.content.id });
    await db.insert(s.posts).values({
      workspace_id: WS, content_id: ct!.id, platform: "facebook", status: "published",
      platform_post_id: "PG1_100", description: "Our spring course opens on Monday", published_url: "https://www.facebook.com/PG1/posts/100",
    });
    await db.insert(s.postReactions).values(reaction("PG1_100", "u1"));

    const list = await get("/engagement");
    expect(list).toContain("Our spring course opens on Monday");
    const opened = await get(`/engagement?open=${encodeURIComponent(rowIds(list)[0]!)}`);
    expect(opened).toContain(`href="/content/${ct!.id}"`);
    expect(opened).toContain('href="https://www.facebook.com/PG1/posts/100"');
  });

  it("falls back to the content title, then to the platform id for a post made elsewhere", async () => {
    if (!TEST_DB) return;
    const [ct] = await db.insert(s.content).values({ workspace_id: WS, title: "Only a title" }).returning({ id: s.content.id });
    await db.insert(s.posts).values({ workspace_id: WS, content_id: ct!.id, platform: "facebook", status: "published", platform_post_id: "PG1_200" });
    await db.insert(s.postReactions).values([reaction("PG1_200", "u1"), reaction("PG1_300", "u1")]);

    const list = await get("/engagement");
    expect(list).toContain("Only a title");
    expect(list).toContain("PG1_300");
  });

  it("shows a remembered preview card for a post made elsewhere, and a text-only card when the platform cannot be read", async () => {
    if (!TEST_DB) return;
    await db.insert(s.postPreviews).values({
      workspace_id: WS, channel_id: CH, post_id: "PG1_700", status: "ready", text: "Posted by hand on Facebook",
      image_url: "https://cdn.poststack.test/media/sha256/ab.jpg", permalink: "https://www.facebook.com/PG1/posts/pfbid700",
    });
    await db.insert(s.postReactions).values([reaction("PG1_700", "u1"), reaction("PG1_701", "u1")]);
    const cached = await get(`/engagement?open=${encodeURIComponent(`${CH}~PG1_700`)}`);
    expect(cached).toContain("data-post-preview");
    expect(cached).toContain("Posted by hand on Facebook");
    expect(cached).toContain('src="https://cdn.poststack.test/media/sha256/ab.jpg"');
    expect(cached).toContain('href="https://www.facebook.com/PG1/posts/pfbid700"');
    // The seeded token cannot be decrypted: no 500, a card without content, and the miss is remembered.
    const failed = await get(`/engagement?open=${encodeURIComponent(`${CH}~PG1_701`)}`);
    expect(failed).toContain("No text to show");
    const [row] = await db.select().from(s.postPreviews).where(eq(s.postPreviews.post_id, "PG1_701"));
    expect(row).toMatchObject({ workspace_id: WS, status: "failed" });
  });

  it("links a video post: publishing keeps the bare video id, the webhook sends page_video", async () => {
    if (!TEST_DB) return;
    await db.insert(s.posts).values({ workspace_id: WS, platform: "facebook", status: "published", platform_post_id: "555", description: "Video caption" });
    await db.insert(s.postReactions).values(reaction("PG1_555", "u1"));
    expect(await get("/engagement")).toContain("Video caption");
  });

  it("does not take text from another workspace's post with the same platform id", async () => {
    if (!TEST_DB) return;
    await db.insert(s.posts).values({ workspace_id: OTHER_WS, platform: "facebook", status: "published", platform_post_id: "PG1_400", description: "Foreign secret text" });
    await db.insert(s.postReactions).values(reaction("PG1_400", "u1"));
    expect(await get("/engagement")).not.toContain("Foreign secret text");
  });

  it("keeps rows of the other workspace out of list, tabs and details", async () => {
    if (!TEST_DB) return;
    await db.insert(s.postReactions).values([reaction("PG1_1", "u1"), reaction("PG9_1", "u1", "like", at(0), OTHER_CH, OTHER_WS)]);
    const list = await get("/engagement");
    expect(rowIds(list)).toHaveLength(1);
    expect(list).not.toContain("PG9_1");
    expect(await get(`/engagement?open=${encodeURIComponent(`${OTHER_CH}~PG9_1`)}`)).not.toContain("Name u1");
  });

  it("reaches every post once going older, and the same pages going newer, across equal times", async () => {
    if (!TEST_DB) return;
    await db.insert(s.postReactions).values(Array.from({ length: 120 }, (_, i) => reaction(`PG1_${i}`, "u1")));

    const first = await get("/engagement");
    expect(rowIds(first)).toHaveLength(50);
    expect(first).toContain("1–50 of 120");
    expect(link(first, "prev")).toBeNull();
    const second = await get(link(first, "next")!);
    expect(second).toContain("51–100 of 120");
    const third = await get(link(second, "next")!);
    expect(third).toContain("101–120 of 120");
    expect(link(third, "next")).toBeNull();
    expect(new Set([...rowIds(first), ...rowIds(second), ...rowIds(third)]).size).toBe(120);

    const backSecond = await get(link(third, "prev")!);
    expect(rowIds(backSecond)).toEqual(rowIds(second));
    const backFirst = await get(link(backSecond, "prev")!);
    expect(rowIds(backFirst)).toEqual(rowIds(first));
  });

  it("orders by latest reaction, so a post with a fresh reaction moves to the top", async () => {
    if (!TEST_DB) return;
    await db.insert(s.postReactions).values([reaction("PG1_old", "u1", "like", at(100)), reaction("PG1_old", "u2", "like", at(1)), reaction("PG1_new", "u1", "like", at(50))]);
    expect(rowIds(await get("/engagement"))).toEqual([`${CH}~PG1_old`, `${CH}~PG1_new`]);
  });

  it("counts live and compacted reactions together, per type, and a fully compacted post stays listed", async () => {
    if (!TEST_DB) return;
    await db.insert(s.postReactions).values([reaction("PG1_mix", "u1", "love"), reaction("PG1_mix", "u2", "like")]);
    await db.insert(s.postReactionStats).values([
      { workspace_id: WS, channel_id: CH, post_id: "PG1_mix", reaction_type: "like", count: 1200, last_reacted_at: at(500) },
      { workspace_id: WS, channel_id: CH, post_id: "PG1_gone", reaction_type: "wow", count: 3, last_reacted_at: at(600) },
    ]);
    const list = await get("/engagement");
    expect(rowIds(list)).toEqual([`${CH}~PG1_mix`, `${CH}~PG1_gone`]);
    expect(list).toContain("1,202");
    expect(list).toContain("👍 1,201");
    expect(list).toContain("❤️ 1");
    expect(list).toContain("😮 3");
  });

  it("names who reacted in the details", async () => {
    if (!TEST_DB) return;
    await db.insert(s.postReactions).values([reaction("PG1_w", "u1"), reaction("PG1_w", "u2", "love")]);
    const list = await get("/engagement");
    expect(list).not.toContain("Name u1");
    const opened = await get(`/engagement?open=${encodeURIComponent(`${CH}~PG1_w`)}`);
    expect(opened).toContain("Name u1");
    expect(opened).toContain("Name u2");
    expect(opened).toContain('href="https://www.facebook.com/PG1_w"');
  });

  it("searches our post text and the channel name, taking % literally", async () => {
    if (!TEST_DB) return;
    await db.insert(s.posts).values({ workspace_id: WS, platform: "facebook", status: "published", platform_post_id: "PG1_t", description: "Discount of 50% today" });
    await db.insert(s.postReactions).values([reaction("PG1_t", "u1"), reaction("PG1_other", "u1"), reaction("IG_1", "u1", "like", at(0), CH2)]);
    expect(rowIds(await get("/engagement?q=discount"))).toEqual([`${CH}~PG1_t`]);
    expect(rowIds(await get("/engagement?q=50%25"))).toEqual([`${CH}~PG1_t`]);
    expect(rowIds(await get("/engagement?q=%25"))).toEqual([`${CH}~PG1_t`]);
    expect(rowIds(await get("/engagement?q=studio"))).toEqual([`${CH2}~IG_1`]);
    expect(rowIds(await get("/engagement?q=nothing-like-this"))).toEqual([]);
  });

  it("filters by account and by brand, including unassigned, and ignores the old 'all' value", async () => {
    if (!TEST_DB) return;
    await db.insert(s.postReactions).values([reaction("PG1_a", "u1"), reaction("IG_b", "u1", "like", at(0), CH2)]);
    expect(rowIds(await get(`/engagement?channel=${CH2}`))).toEqual([`${CH2}~IG_b`]);
    expect(rowIds(await get("/engagement?brand=acme"))).toEqual([`${CH}~PG1_a`]);
    expect(rowIds(await get("/engagement?brand=__unassigned__"))).toEqual([`${CH2}~IG_b`]);
    expect(rowIds(await get("/engagement?brand=all&channel=all"))).toHaveLength(2);
    expect(rowIds(await get(`/engagement?channel=${OTHER_CH}`))).toEqual([]);
  });

  it("survives a broken cursor and a broken open value", async () => {
    if (!TEST_DB) return;
    await db.insert(s.postReactions).values(reaction("PG1_a", "u1"));
    expect(rowIds(await get("/engagement?after=%%%&before=abc"))).toHaveLength(1);
    expect(rowIds(await get("/engagement?open=not-a-post"))).toHaveLength(1);
    expect(rowIds(await get("/engagement?open=not-a-uuid~x"))).toHaveLength(1);
  });
});

describe("/engagement/messages view", () => {
  async function dm(name: string, mid: string, created: Date, text: string | null = null) {
    const [ct] = await db.insert(s.contacts).values({ workspace_id: WS, display_name: name }).returning({ id: s.contacts.id });
    const [cv] = await db.insert(s.conversations).values({ workspace_id: WS, channel_id: CH2, contact_id: ct!.id, platform: "instagram" }).returning({ id: s.conversations.id });
    if (text) await db.insert(s.messages).values({ conversation_id: cv!.id, direction: "outbound", text, platform_message_id: mid });
    const [r] = await db.insert(s.messageReactions).values({
      workspace_id: WS, channel_id: CH2, conversation_id: cv!.id, contact_id: ct!.id, reacted_mid: mid, reaction_type: "love", emoji: "❤️", created_at: created,
    }).returning({ id: s.messageReactions.id });
    return { conversation: cv!.id, reaction: r!.id };
  }

  it("lists who reacted to which of our messages and opens the conversation", async () => {
    if (!TEST_DB) return;
    const { conversation, reaction: id } = await dm("Maja", "MID-1", at(0), "Here is your course link");
    const list = await get("/engagement/messages");
    expect(rowIds(list)).toEqual([id]);
    expect(list).toContain("Maja");
    expect(list).toContain("Here is your course link");
    expect(await get(`/engagement/messages?open=${id}`)).toContain(`href="/inbox/${conversation}"`);
  });

  it("pages over the whole table and searches by contact name", async () => {
    if (!TEST_DB) return;
    for (let i = 0; i < 60; i++) await dm(i === 7 ? "Needle Person" : `Person ${i}`, `M${i}`, at(i));
    const first = await get("/engagement/messages");
    expect(first).toContain("1–50 of 60");
    expect(await get(link(first, "next")!)).toContain("51–60 of 60");
    expect(rowIds(await get("/engagement/messages?q=needle"))).toHaveLength(1);
  });

  it("the view tabs carry the filters and show both counts", async () => {
    if (!TEST_DB) return;
    await dm("Maja", "MID-1", at(0));
    await db.insert(s.postReactions).values(reaction("IG_b", "u1", "like", at(0), CH2));
    const body = await get(`/engagement?channel=${CH2}`);
    expect(decode(body)).toContain(`href="/engagement/messages?channel=${CH2}"`);
    expect(body).toMatch(/Posts\s*<b>1<\/b>/);
    expect(body).toMatch(/Message reactions\s*<b>1<\/b>/);
    expect(await get(`/engagement/messages?channel=${CH}`)).toContain("0 reactions");
  });
});

describe("message_reactions index", () => {
  it("exists after migrations and the delta is safe to repeat", async () => {
    if (!TEST_DB) return;
    const { readFile } = await import("node:fs/promises");
    const { sql } = await import("drizzle-orm");
    const delta = await readFile(new URL("../../../../drizzle/reconcile/0018_message_reactions_workspace_created_idx.sql", import.meta.url), "utf8");
    await db.execute(sql.raw(delta));
    await db.execute(sql.raw(delta));
    const { rows } = await db.execute<{ indexdef: string }>(sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'message_reactions_workspace_id_created_at_idx'`);
    expect(rows[0]?.indexdef).toContain("(workspace_id, created_at)");
  });
});

describe("/engagement on a free instance", () => {
  it("locks both views", async () => {
    if (!TEST_DB) return;
    const gate = await import("@/lib/license/gate");
    await db.delete(s.instanceLicense);
    gate.invalidateLicenseCache();
    for (const path of ["/engagement", "/engagement/messages"]) expect(await get(path)).toContain("Seeing who reacted to your posts is a PRO feature");
  });
});

describe("/engagement realistic volume", () => {
  it("matches additive webhook totals, type breakdowns and both brand/account scopes", async () => {
    if (!TEST_DB) return;
    const seed = await seedEngagement(db.$client, WS);
    try {
      const { rows: counts } = await db.$client.query<{ event_type: string; n: number }>(
        "SELECT event_type, count(*)::int AS n FROM webhook_events WHERE channel_id = ANY($1::uuid[]) GROUP BY event_type", [seed.channels],
      );
      expect(Object.fromEntries(counts.map((r) => [r.event_type, r.n]))).toEqual({ post_reaction: 1127, reaction: 60, comment: 1, story_mention: 1 });
      const { postFacts } = await import("./engagement-data");
      const facts = await postFacts(WS, [{ channelId: seed.channels[0]!, postId: "991000000000000_100" }]);
      const big = facts.get(`${seed.channels[0]}~991000000000000_100`)!;
      expect(big.total).toBe(ENGAGEMENT_BIG_TOTAL);
      expect(Object.fromEntries(big.byType.map((r) => [r.type, r.n]))).toEqual({ like: 151, love: 151, care: 151, haha: 151, wow: 151, sad: 151, angry: 151 });
      for (const [query, posts, messages] of [["", 63, 60], ["brand=engdata-a", 62, 59], ["brand=engdata-b", 1, 1], [`channel=${seed.channels[0]}`, 61, 57], [`channel=${seed.channels[1]}`, 1, 2], ["brand=absent", 0, 0]] as const) {
        const body = await get(`/engagement?${query}`);
        expect(body).toMatch(new RegExp(`Posts\\s*<b>${posts}</b>`));
        expect(body).toMatch(new RegExp(`Message reactions\\s*<b>${messages}</b>`));
        const messageBody = await get(`/engagement/messages?${query}`);
        expect(messageBody).toMatch(new RegExp(`Message reactions\\s*<b>${messages}</b>`));
      }
      let path: string | null = "/engagement?brand=engdata-a";
      const ids: string[] = [];
      let sum = 0;
      while (path) {
        const body = await get(path);
        const page = rowIds(body);
        ids.push(...page);
        const keys = page.map((id) => { const [channelId, postId] = id.split("~"); return { channelId: channelId!, postId: postId! }; });
        sum += [...(await postFacts(WS, keys)).values()].reduce((n, f) => n + f.total, 0);
        path = link(body, "next");
      }
      expect(new Set(ids).size).toBe(62);
      expect(ids).toHaveLength(62);
      expect(sum).toBe(1120);
      const first = await get(`/engagement/messages?channel=${seed.channels[0]}`);
      const second = await get(link(first, "next")!);
      expect(new Set([...rowIds(first), ...rowIds(second)]).size).toBe(57);
      expect(rowIds(await get(link(second, "prev")!))).toEqual(rowIds(first));
    } finally {
      await clearEngagement(db.$client, WS, seed);
    }
  });
});

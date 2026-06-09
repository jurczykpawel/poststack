import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createHash } from "crypto";
import { eq } from "drizzle-orm";

const TEST_DB = process.env.TEST_DATABASE_URL;
const RAW_KEY = "rs_live_contacts_list_key_abcdef0123";

let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let GET: typeof import("./route").GET;

const WS = "eeeeeeee-0000-0000-0000-0000000000a1";
const CH = "eeeeeeee-0000-0000-0000-0000000000a2";
const ALICE = "eeeeeeee-0000-0000-0000-0000000000a3";
const BOB = "eeeeeeee-0000-0000-0000-0000000000a4";
const TAG = "eeeeeeee-0000-0000-0000-0000000000a5";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.TOKEN_ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  ({ GET } = await import("./route"));
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.insert(s.workspaces).values({ id: WS, name: "C", slug: `c-${WS}` });
  await db.insert(s.channels).values({ id: CH, workspace_id: WS, platform: "instagram", platform_id: "PG-C", token_encrypted: "x", webhook_secret: "s" });
  await db.insert(s.apiKeys).values({ workspace_id: WS, name: "k", key_hash: createHash("sha256").update(RAW_KEY).digest("hex"), key_prefix: "rs_live_cl" });
  await db.insert(s.contacts).values([
    { id: ALICE, workspace_id: WS, display_name: "Alice", last_interaction_at: new Date(Date.now() - 1000) },
    { id: BOB, workspace_id: WS, display_name: "Bob", last_interaction_at: new Date(Date.now() - 2000) },
  ]);
  await db.insert(s.contactChannels).values({ contact_id: ALICE, channel_id: CH, platform_sender_id: "PSID-A", platform_username: "alice_ig" });
  await db.insert(s.tags).values({ id: TAG, workspace_id: WS, name: "vip", color: "#fff" });
  await db.insert(s.contactTags).values({ contact_id: ALICE, tag_id: TAG });
});

afterAll(async () => {
  if (TEST_DB) await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
});

const req = (qs = "") => new Request(`http://x/api/v1/contacts${qs}`, { headers: { authorization: `Bearer ${RAW_KEY}` } });

describe("contacts list (real Postgres)", () => {
  it("lists contacts with nested channels + tags in the API response shape", async () => {
    if (!TEST_DB) return;
    const res = await GET(req());
    const { data } = await res.json();
    const alice = data.find((c: { id: string }) => c.id === ALICE);
    expect(alice.contact_channels[0]).toMatchObject({ platform_sender_id: "PSID-A", platform_username: "alice_ig" });
    expect(alice.contact_channels[0].channel).toEqual({ platform: "instagram" });
    expect(alice.tags[0]).toEqual({ tag: { id: TAG, name: "vip", color: "#fff" } });
  });

  it("searches by display name", async () => {
    if (!TEST_DB) return;
    const { data } = await (await GET(req("?q=ali"))).json();
    expect(data.map((c: { id: string }) => c.id)).toEqual([ALICE]);
  });

  it("searches by channel username (relation exists)", async () => {
    if (!TEST_DB) return;
    const { data } = await (await GET(req("?q=alice_ig"))).json();
    expect(data.map((c: { id: string }) => c.id)).toEqual([ALICE]);
  });

  it("filters by tag (relation exists)", async () => {
    if (!TEST_DB) return;
    const { data } = await (await GET(req("?tag=vip"))).json();
    expect(data.map((c: { id: string }) => c.id)).toEqual([ALICE]);
  });

  //  — keyset pagination must return every contact exactly once even when many share a
  // boundary timestamp and others have NULL activity (no skips, no stuck null cursor).
  it("paginates over tied and null activity timestamps without skips or duplicates", async () => {
    if (!TEST_DB) return;
    const T = new Date("2025-06-01T00:00:00.000Z");
    await db.insert(s.contacts).values([
      ...Array.from({ length: 5 }, (_, i) => ({ workspace_id: WS, display_name: `Tie${i}`, last_interaction_at: T })),
      ...Array.from({ length: 3 }, (_, i) => ({ workspace_id: WS, display_name: `Null${i}`, last_interaction_at: null })),
    ]);
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let guard = 0; guard < 50; guard++) {
      const url: string = cursor ? `?limit=2&cursor=${encodeURIComponent(cursor)}` : "?limit=2";
      const { data, meta } = await (await GET(req(url))).json();
      for (const c of data as { id: string }[]) {
        expect(seen.has(c.id)).toBe(false); // no duplicate across pages
        seen.add(c.id);
      }
      if (!meta.has_more) break;
      cursor = meta.next_cursor;
      expect(cursor).not.toBeNull(); // never stuck, even at the NULL group
    }
    const all = await db.select().from(s.contacts).where(eq(s.contacts.workspace_id, WS));
    expect(seen.size).toBe(all.length); // every contact returned exactly once
  });
});

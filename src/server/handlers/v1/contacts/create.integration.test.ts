import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createHash } from "crypto";
import { and, eq } from "drizzle-orm";
import { licenseInstance } from "@/lib/license/__fixtures__/license-instance";

const TEST_DB = process.env.TEST_DATABASE_URL;
const RAW_KEY = "sk_live_contacts_create_key_abcd0123";

let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let POST: typeof import("./route").POST;

// Valid RFC-4122 v4 UUIDs (version nibble 4, variant 8) — the POST body validates channel_id with
// z.string().uuid(), and real channel ids are defaultRandom() v4s.
const WS = "c0ffee00-0000-4000-8000-000000000b01";
const CH = "c0ffee00-0000-4000-8000-000000000b02";
const OTHER_WS = "c0ffee00-0000-4000-8000-000000000b08";
const OTHER_CH = "c0ffee00-0000-4000-8000-000000000b09";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  ({ POST } = await import("./route"));
  await licenseInstance();
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.delete(s.workspaces).where(eq(s.workspaces.id, OTHER_WS));
  await db.insert(s.workspaces).values([
    { id: WS, name: "C", slug: `c-${WS}` },
    { id: OTHER_WS, name: "O", slug: `o-${OTHER_WS}` },
  ]);
  await db.insert(s.channels).values([
    { id: CH, workspace_id: WS, platform: "instagram", platform_id: "PG-B", token_encrypted: "x", webhook_secret: "s" },
    { id: OTHER_CH, workspace_id: OTHER_WS, platform: "instagram", platform_id: "PG-O", token_encrypted: "x", webhook_secret: "s" },
  ]);
  await db.insert(s.apiKeys).values({ workspace_id: WS, name: "k", key_hash: createHash("sha256").update(RAW_KEY).digest("hex"), key_prefix: "sk_live_cc" });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.delete(s.workspaces).where(eq(s.workspaces.id, OTHER_WS));
  await db.delete(s.instanceLicense);
});

const post = (body: unknown, auth = true) =>
  POST(
    new Request("http://x/api/v1/contacts", {
      method: "POST",
      headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${RAW_KEY}` } : {}) },
      body: JSON.stringify(body),
    }),
  );

describe.skipIf(!TEST_DB)("POST /api/v1/contacts", () => {
  it("creates a single contact with a channel link and tags (handle as placeholder sender id)", async () => {
    const res = await post({
      channel_id: CH,
      platform_username: "anna_design",
      display_name: "Anna",
      email: "anna@example.com",
      phone: "+48501761834",
      metadata: { city: "Warsaw" },
      tags: ["customer", "vip"],
    });
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data).toMatchObject({ created: 1, updated: 0, failed: 0 });

    const cc = await db.query.contactChannels.findFirst({
      where: and(eq(s.contactChannels.channel_id, CH), eq(s.contactChannels.platform_sender_id, "anna_design")),
      columns: { contact_id: true, platform_username: true },
    });
    expect(cc?.platform_username).toBe("anna_design");

    const contact = await db.query.contacts.findFirst({ where: eq(s.contacts.id, cc!.contact_id), columns: { email: true, phone: true, metadata: true } });
    expect(contact?.email).toBe("anna@example.com");
    expect(contact?.phone).toBe("+48501761834");
    expect(contact?.metadata).toMatchObject({ city: "Warsaw" });

    const tagCount = await db.$count(s.tags, eq(s.tags.workspace_id, WS));
    expect(tagCount).toBe(2);
  });

  it("is idempotent: re-importing the same row updates instead of duplicating, and merges metadata + tags", async () => {
    await post({ channel_id: CH, platform_username: "bob", metadata: { a: 1 }, tags: ["lead"] });
    const res = await post({ channel_id: CH, platform_username: "bob", email: "bob@example.com", metadata: { b: 2 }, tags: ["vip"] });
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data).toMatchObject({ created: 0, updated: 1, failed: 0 });

    const links = await db.select().from(s.contactChannels).where(and(eq(s.contactChannels.channel_id, CH), eq(s.contactChannels.platform_sender_id, "bob")));
    expect(links).toHaveLength(1);

    const contact = await db.query.contacts.findFirst({ where: eq(s.contacts.id, links[0].contact_id), columns: { email: true, metadata: true } });
    expect(contact?.email).toBe("bob@example.com");
    expect(contact?.metadata).toMatchObject({ a: 1, b: 2 }); // merged, not clobbered

    const tagLinks = await db.select().from(s.contactTags).where(eq(s.contactTags.contact_id, links[0].contact_id));
    expect(tagLinks).toHaveLength(2); // lead + vip, additive
  });

  it("emits contact.created on a create but NOT on a re-import (update)", async () => {
    await post({ channel_id: CH, platform_username: "carol" });
    const afterCreate = await db
      .select()
      .from(s.events)
      .where(and(eq(s.events.workspace_id, WS), eq(s.events.type, "contact.created")));
    expect(afterCreate).toHaveLength(1);

    await post({ channel_id: CH, platform_username: "carol", email: "carol@example.com" }); // update
    const afterReimport = await db
      .select()
      .from(s.events)
      .where(and(eq(s.events.workspace_id, WS), eq(s.events.type, "contact.created")));
    expect(afterReimport).toHaveLength(1); // unchanged — a re-import is not a creation
  });

  it("reports per-row errors without aborting the batch (unknown / cross-tenant channel)", async () => {
    const res = await post([
      { channel_id: CH, platform_username: "ok_one" },
      { channel_id: OTHER_CH, platform_username: "cross_tenant" }, // belongs to another workspace
    ]);
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data).toMatchObject({ created: 1, failed: 1 });
    expect(data.results[1]).toMatchObject({ index: 1, status: "error" });
    // The cross-tenant channel must not receive a contact.
    const leaked = await db.select().from(s.contactChannels).where(eq(s.contactChannels.channel_id, OTHER_CH));
    expect(leaked).toHaveLength(0);
  });

  it("rejects a row with neither sender id nor username (422)", async () => {
    const res = await post({ channel_id: CH, display_name: "No identity" });
    expect(res.status).toBe(422);
  });

  it("requires authentication", async () => {
    const res = await post({ channel_id: CH, platform_username: "x" }, false);
    expect(res.status).toBe(401);
  });
});

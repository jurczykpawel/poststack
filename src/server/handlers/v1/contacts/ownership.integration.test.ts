import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createHash } from "crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { workspaces, contacts, apiKeys, channels, contactChannels, commentLogs, outboundDeliveries, autoReplyRules, ruleSendCounts, processedEvents, tags, contactTags } from "@/db/schema";

const TEST_DB = process.env.TEST_DATABASE_URL;
const RAW_KEY = "rs_live_smoke_ownership_key_abcdef";

let db: typeof import("@/lib/db").db;
let GET: typeof import("./[contactId]/route").GET;
let PATCH: typeof import("./[contactId]/route").PATCH;
let DELETE: typeof import("./[contactId]/route").DELETE;

const WS_A = "ffffffff-0000-0000-0000-00000000000a";
const WS_B = "ffffffff-0000-0000-0000-00000000000b";
const CONTACT_A = "ffffffff-0000-0000-0000-0000000000a1";
const CONTACT_B = "ffffffff-0000-0000-0000-0000000000b1";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.TOKEN_ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";

  ({ db } = await import("@/lib/db"));
  ({ GET, PATCH, DELETE } = await import("./[contactId]/route"));
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.delete(workspaces).where(inArray(workspaces.id, [WS_A, WS_B]));
  await db.insert(workspaces).values({ id: WS_A, name: "A", slug: `a-${WS_A}` });
  await db.insert(workspaces).values({ id: WS_B, name: "B", slug: `b-${WS_B}` });
  await db.insert(contacts).values({ id: CONTACT_A, workspace_id: WS_A });
  await db.insert(contacts).values({ id: CONTACT_B, workspace_id: WS_B });
  await db.insert(apiKeys).values({
    workspace_id: WS_A,
    name: "A key",
    key_hash: createHash("sha256").update(RAW_KEY).digest("hex"),
    key_prefix: "rs_live_smoke",
  });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(workspaces).where(inArray(workspaces.id, [WS_A, WS_B]));
  await db.$client.end();
});

function reqAsA() {
  return new Request("http://x/api/v1/contacts/x", {
    headers: { authorization: `Bearer ${RAW_KEY}` },
  });
}
const ctx = (contactId: string) => ({ params: Promise.resolve({ contactId }) });

describe("ownership scoping via Bearer API key (real Postgres)", () => {
  it("reads a contact in the key's own workspace", async () => {
    if (!TEST_DB) return;
    const res = await GET(reqAsA(), ctx(CONTACT_A));
    expect(res.status).toBe(200);
  });

  it("cannot read a contact in another workspace (404, not cross-workspace leak)", async () => {
    if (!TEST_DB) return;
    const res = await GET(reqAsA(), ctx(CONTACT_B));
    expect(res.status).toBe(404);
  });

  it("rejects an unknown key", async () => {
    if (!TEST_DB) return;
    const res = await GET(
      new Request("http://x/api/v1/contacts/x", { headers: { authorization: "Bearer rs_live_nope" } }),
      ctx(CONTACT_A),
    );
    expect(res.status).toBe(401);
  });

  // the PATCH/DELETE WHERE carries workspace_id alongside the PK, so a cross-workspace
  // id can never mutate another tenant's row. Black-box behaviour is unchanged (404, untouched).
  it("cannot patch a contact in another workspace (404, unchanged)", async () => {
    if (!TEST_DB) return;
    const res = await PATCH(
      new Request("http://x/api/v1/contacts/x", {
        method: "PATCH",
        headers: { authorization: `Bearer ${RAW_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ is_subscribed: false }),
      }),
      ctx(CONTACT_B),
    );
    expect(res.status).toBe(404);
    const row = await db.query.contacts.findFirst({ where: and(eq(contacts.id, CONTACT_B), eq(contacts.workspace_id, WS_B)) });
    expect(row?.is_subscribed).toBe(true);
  });

  // PATCH tag_ids actually syncs the contact's tags (the OpenAPI spec advertised the
  // field; the handler used to silently drop it → a no-op 200). A tag from another workspace is
  // ignored, never assigned cross-tenant.
  it("syncs tag_ids on PATCH and ignores foreign-workspace tags", async () => {
    if (!TEST_DB) return;
    const patchTags = (tag_ids: string[]) =>
      PATCH(
        new Request("http://x/api/v1/contacts/x", {
          method: "PATCH",
          headers: { authorization: `Bearer ${RAW_KEY}`, "content-type": "application/json" },
          body: JSON.stringify({ tag_ids }),
        }),
        ctx(CONTACT_A),
      );
    const [t1] = await db.insert(tags).values({ workspace_id: WS_A, name: "vip" }).returning({ id: tags.id });
    const [t2] = await db.insert(tags).values({ workspace_id: WS_A, name: "lead" }).returning({ id: tags.id });
    const [foreign] = await db.insert(tags).values({ workspace_id: WS_B, name: "other" }).returning({ id: tags.id });

    // Assign t1 + a foreign-workspace tag → only t1 sticks.
    const res = await patchTags([t1.id, foreign.id]);
    expect(res.status).toBe(200);
    const after1 = await db.select().from(contactTags).where(eq(contactTags.contact_id, CONTACT_A));
    expect(after1.map((r) => r.tag_id)).toEqual([t1.id]);

    // Re-PATCH with [t2] → the set is replaced (t1 removed, t2 added).
    await patchTags([t2.id]);
    const after2 = await db.select().from(contactTags).where(eq(contactTags.contact_id, CONTACT_A));
    expect(after2.map((r) => r.tag_id)).toEqual([t2.id]);

    // Empty array clears all tags.
    await patchTags([]);
    const after3 = await db.select().from(contactTags).where(eq(contactTags.contact_id, CONTACT_A));
    expect(after3.length).toBe(0);
  });
});

// erasing a contact (GDPR) must only delete the comment logs that belong to THAT
// contact. A platform sender id is unique only per channel, so two contacts on different
// channels can share the same sender id. Matching comment logs by sender id alone would
// wipe the other contact's logs.
describe("contact erase scopes comment-log deletion per (channel, sender) (real Postgres)", () => {
  const CH_1 = "ffffffff-0000-0000-0000-0000000000c1";
  const CH_2 = "ffffffff-0000-0000-0000-0000000000c2";
  const CONTACT_D1 = "ffffffff-0000-0000-0000-0000000000d1";
  const CONTACT_D2 = "ffffffff-0000-0000-0000-0000000000d2";
  const SENDER = "shared-sender-9000";
  const COMMENT_1 = "ffffffff-0000-0000-0000-00000000e001";
  const COMMENT_2 = "ffffffff-0000-0000-0000-00000000e002";

  it("deletes only the erased contact's comment logs, not a same-sender contact on another channel", async () => {
    if (!TEST_DB) return;

    // Two channels in the same workspace.
    await db.insert(channels).values([
      { id: CH_1, workspace_id: WS_A, platform: "instagram", platform_id: "PG-D1", token_encrypted: "e", webhook_secret: "s" },
      { id: CH_2, workspace_id: WS_A, platform: "instagram", platform_id: "PG-D2", token_encrypted: "e", webhook_secret: "s" },
    ]);
    // Two contacts, each on a different channel but with the SAME platform sender id.
    await db.insert(contacts).values([
      { id: CONTACT_D1, workspace_id: WS_A },
      { id: CONTACT_D2, workspace_id: WS_A },
    ]);
    await db.insert(contactChannels).values([
      { contact_id: CONTACT_D1, channel_id: CH_1, platform_sender_id: SENDER },
      { contact_id: CONTACT_D2, channel_id: CH_2, platform_sender_id: SENDER },
    ]);
    // A comment log for each contact, keyed by (channel, author) — same author id, different channel.
    await db.insert(commentLogs).values([
      { id: COMMENT_1, channel_id: CH_1, workspace_id: WS_A, platform_comment_id: "c-1", author_id: SENDER, comment_text: "for D1" },
      { id: COMMENT_2, channel_id: CH_2, workspace_id: WS_A, platform_comment_id: "c-2", author_id: SENDER, comment_text: "for D2" },
    ]);

    const res = await DELETE(reqAsA(), ctx(CONTACT_D1));
    expect(res.status).toBe(204);

    // D1's log is gone; D2's same-sender log on the other channel survives.
    expect(await db.query.commentLogs.findFirst({ where: eq(commentLogs.id, COMMENT_1) })).toBeUndefined();
    expect(await db.query.commentLogs.findFirst({ where: eq(commentLogs.id, COMMENT_2) })).toBeDefined();
    // D2 itself is untouched.
    expect(await db.query.contacts.findFirst({ where: and(eq(contacts.id, CONTACT_D2), eq(contacts.workspace_id, WS_A)) })).toBeDefined();
  });
});

// erasing a contact must take its outbound-delivery rows with it (they carry the
// recipient PSID + message text in payload). The contact_id FK cascade does this.
describe("contact erase cascades outbound_deliveries (real Postgres)", () => {
  const CH_X = "ffffffff-0000-0000-0000-0000000000f1";
  const KEEP = "ffffffff-0000-0000-0000-0000000000f2";
  const ERASE = "ffffffff-0000-0000-0000-0000000000f3";

  it("removes the erased contact's delivery rows (PSID + text) but keeps another contact's", async () => {
    if (!TEST_DB) return;
    await db.insert(channels).values({ id: CH_X, workspace_id: WS_A, platform: "instagram", platform_id: "PG-X", token_encrypted: "e", webhook_secret: "s" });
    await db.insert(contacts).values([{ id: KEEP, workspace_id: WS_A }, { id: ERASE, workspace_id: WS_A }]);
    await db.insert(outboundDeliveries).values([
      { delivery_key: "dk-erase", workspace_id: WS_A, channel_id: CH_X, contact_id: ERASE, task_name: "outgoing-message", status: "sent", payload: { contactId: ERASE, recipientPlatformId: "PSID-ERASE", content: { text: "secret dm" } } },
      { delivery_key: "dk-keep", workspace_id: WS_A, channel_id: CH_X, contact_id: KEEP, task_name: "outgoing-message", status: "sent", payload: { contactId: KEEP, recipientPlatformId: "PSID-KEEP", content: { text: "other dm" } } },
    ]);

    const res = await DELETE(reqAsA(), ctx(ERASE));
    expect(res.status).toBe(204);

    expect(await db.query.outboundDeliveries.findFirst({ where: eq(outboundDeliveries.delivery_key, "dk-erase") })).toBeUndefined();
    expect(await db.query.outboundDeliveries.findFirst({ where: eq(outboundDeliveries.delivery_key, "dk-keep") })).toBeDefined();
  });

  // private-reply deliveries now carry contact_id, so erasure reaches them too (the
  // row cascades and the queued job is scrubbed by contactId) — closing the gap.
  it("erases private-reply deliveries and queued jobs (contact_id now stamped)", async () => {
    if (!TEST_DB) return;
    const ERASE_PR = "ffffffff-0000-4000-8000-0000000000fa";
    await db.insert(channels).values({ id: CH_X, workspace_id: WS_A, platform: "instagram", platform_id: "PG-X", token_encrypted: "e", webhook_secret: "s" });
    await db.insert(contacts).values({ id: ERASE_PR, workspace_id: WS_A });
    await db.insert(outboundDeliveries).values({
      delivery_key: "pr-erase", workspace_id: WS_A, channel_id: CH_X, contact_id: ERASE_PR,
      task_name: "outgoing-private-reply", status: "sent", payload: { contactId: ERASE_PR, commentId: "cmt-x", text: "private text" },
    });
    await db.execute(sql`select graphile_worker.add_job('outgoing-private-reply', ${JSON.stringify({ channelId: CH_X, conversationId: "x", contactId: ERASE_PR, commentId: "cmt-x", text: "private text" })}::json)`);

    const res = await DELETE(reqAsA(), ctx(ERASE_PR));
    expect(res.status).toBe(204);

    expect(await db.query.outboundDeliveries.findFirst({ where: eq(outboundDeliveries.delivery_key, "pr-erase") })).toBeUndefined();
    const jobs = await db.execute(sql`select count(*)::int as n from graphile_worker._private_jobs where payload->>'contactId' = ${ERASE_PR}`);
    expect(Number((jobs.rows[0] as { n: number }).n)).toBe(0);
  });
});

// erasing a contact must take its rule_send_counts rows with it (lifetime counters
// are never TTL-pruned; without the FK they'd linger after erasure).
describe("contact erase cascades rule_send_counts (real Postgres)", () => {
  const RULE = "ffffffff-0000-0000-0000-0000000000e1";
  const ERASE2 = "ffffffff-0000-0000-0000-0000000000e2";

  it("removes the erased contact's send-count rows", async () => {
    if (!TEST_DB) return;
    await db.insert(autoReplyRules).values({ id: RULE, workspace_id: WS_A, name: "R", trigger_type: "keyword", trigger_config: {}, response_type: "text", response_config: { text: "x" } });
    await db.insert(contacts).values({ id: ERASE2, workspace_id: WS_A });
    await db.insert(ruleSendCounts).values({ rule_id: RULE, contact_id: ERASE2, count: 3 });

    const res = await DELETE(reqAsA(), ctx(ERASE2));
    expect(res.status).toBe(204);

    expect((await db.select().from(ruleSendCounts).where(eq(ruleSendCounts.contact_id, ERASE2))).length).toBe(0);
  });
});

// a reaction event-dedup key embeds the reactor's PSID and is reached by no table
// cascade; erasure scrubs the keys for the contact's (channel, sender) pairs so the PSID does
// not outlive the contact. A key for a different PSID on the same channel survives.
describe("contact erase scrubs PSID-bearing processed_events keys (real Postgres)", () => {
  const CH_P = "ffffffff-0000-0000-0000-0000000000a7";
  const CONTACT_P = "ffffffff-0000-0000-0000-0000000000a8";
  const PSID_P = "psid-reaction-aud66";
  const PSID_OTHER = "psid-reaction-other";

  it("removes processed_events keyed by the erased contact's PSID, keeps another PSID's", async () => {
    if (!TEST_DB) return;
    await db.insert(channels).values({ id: CH_P, workspace_id: WS_A, platform: "instagram", platform_id: "PG-P", token_encrypted: "e", webhook_secret: "s" });
    await db.insert(contacts).values({ id: CONTACT_P, workspace_id: WS_A });
    await db.insert(contactChannels).values({ contact_id: CONTACT_P, channel_id: CH_P, platform_sender_id: PSID_P });
    const mineKey = `reaction:${CH_P}:${PSID_P}:mid-1:love:123`;
    const otherKey = `reaction:${CH_P}:${PSID_OTHER}:mid-2:love:456`;
    await db.insert(processedEvents).values([{ key: mineKey }, { key: otherKey }]);

    const res = await DELETE(reqAsA(), ctx(CONTACT_P));
    expect(res.status).toBe(204);

    expect(await db.query.processedEvents.findFirst({ where: eq(processedEvents.key, mineKey) })).toBeUndefined();
    expect(await db.query.processedEvents.findFirst({ where: eq(processedEvents.key, otherKey) })).toBeDefined();
    // Cleanup the surviving control row (no contact owns it).
    await db.delete(processedEvents).where(eq(processedEvents.key, otherKey));
  });

  // the sender id is interpolated into a LIKE pattern. A `_`/`%` in it must match
  // literally (ESCAPE), or the scrub would over-delete a neighbour's keys on the same channel.
  it("escapes LIKE wildcards in the sender id so it does not over-delete neighbours", async () => {
    if (!TEST_DB) return;
    const CH_W = "ffffffff-0000-0000-0000-0000000000a9";
    const CONTACT_W = "ffffffff-0000-0000-0000-0000000000aa";
    const PSID_WILD = "user_1"; // `_` is a single-char LIKE wildcard if unescaped
    await db.insert(channels).values({ id: CH_W, workspace_id: WS_A, platform: "instagram", platform_id: "PG-W", token_encrypted: "e", webhook_secret: "s" });
    await db.insert(contacts).values({ id: CONTACT_W, workspace_id: WS_A });
    await db.insert(contactChannels).values({ contact_id: CONTACT_W, channel_id: CH_W, platform_sender_id: PSID_WILD });
    const mineKey = `reaction:${CH_W}:user_1:mid:love:1`;
    const neighbourKey = `reaction:${CH_W}:userX1:mid:love:2`; // would match `user_1` if `_` were a wildcard
    await db.insert(processedEvents).values([{ key: mineKey }, { key: neighbourKey }]);

    const res = await DELETE(reqAsA(), ctx(CONTACT_W));
    expect(res.status).toBe(204);

    expect(await db.query.processedEvents.findFirst({ where: eq(processedEvents.key, mineKey) })).toBeUndefined();
    expect(await db.query.processedEvents.findFirst({ where: eq(processedEvents.key, neighbourKey) })).toBeDefined();
    await db.delete(processedEvents).where(eq(processedEvents.key, neighbourKey));
  });
});

// queued/dead-letter graphile jobs carry the contact's PSID + message text in their
// payload and are reached by no table cascade; erasure scrubs them by sender id / contact id.
describe("contact erase scrubs queued graphile jobs (real Postgres)", () => {
  const CH_J = "ffffffff-0000-0000-0000-000000000091";
  const CONTACT_J = "ffffffff-0000-0000-0000-000000000092";
  const PSID_J = "psid-scrub-aud57";

  const countForPsid = async () => {
    const r = await db.execute(sql`select count(*)::int as n from graphile_worker._private_jobs where payload->>'senderId' = ${PSID_J}`);
    return Number((r.rows[0] as { n: number }).n);
  };

  it("removes queued jobs whose payload carries the erased contact's sender id", async () => {
    if (!TEST_DB) return;
    await db.insert(channels).values({ id: CH_J, workspace_id: WS_A, platform: "instagram", platform_id: "PG-J", token_encrypted: "e", webhook_secret: "s" });
    await db.insert(contacts).values({ id: CONTACT_J, workspace_id: WS_A });
    await db.insert(contactChannels).values({ contact_id: CONTACT_J, channel_id: CH_J, platform_sender_id: PSID_J });
    // A queued incoming-message job carrying this contact's PSID (and message text) in payload.
    const payload = { platform: "instagram", pageId: "PG-J", senderId: PSID_J, recipientId: "PG-J", mid: "m-scrub", text: "private text", timestamp: 0 };
    await db.execute(sql`select graphile_worker.add_job('incoming-message', ${JSON.stringify(payload)}::json)`);
    expect(await countForPsid()).toBe(1);

    const res = await DELETE(reqAsA(), ctx(CONTACT_J));
    expect(res.status).toBe(204);

    expect(await countForPsid()).toBe(0);
  });
});

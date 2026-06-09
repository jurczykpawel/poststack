import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createHash } from "crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { workspaces, contacts, apiKeys, channels, contactChannels, commentLogs, outboundDeliveries, autoReplyRules, ruleSendCounts } from "@/db/schema";

const TEST_DB = process.env.TEST_DATABASE_URL;
const RAW_KEY = "rs_live_smoke_ownership_key_abcdef";

let db: typeof import("@/lib/db").db;
let GET: typeof import("./[contactId]/route").GET;
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
  ({ GET, DELETE } = await import("./[contactId]/route"));
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
});

//  — erasing a contact (GDPR) must only delete the comment logs that belong to THAT
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

//  — erasing a contact must take its outbound-delivery rows with it (they carry the
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
});

//  — erasing a contact must take its rule_send_counts rows with it (lifetime counters
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

//  — queued/dead-letter graphile jobs carry the contact's PSID + message text in their
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

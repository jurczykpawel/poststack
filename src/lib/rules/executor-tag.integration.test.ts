import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { and, eq, sql } from "drizzle-orm";

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let evaluateRules: typeof import("./executor").evaluateRules;
let closeQueue: typeof import("@/lib/queue/client").closeQueue;

const WS = "c0ffee01-0000-4000-8000-000000000d01";
const CH = "c0ffee01-0000-4000-8000-000000000d02";
const CONTACT = "c0ffee01-0000-4000-8000-000000000d03";
const CONV = "c0ffee01-0000-4000-8000-000000000d04";

const baseInput = {
  workspaceId: WS,
  channelId: CH,
  platform: "facebook" as const,
  conversationId: CONV,
  contactId: CONTACT,
  recipientPlatformId: "PSID-TAG",
  text: "hi there",
  eventType: "message" as const,
};

async function seedRule(over: Record<string, unknown> = {}) {
  const [r] = await db
    .insert(s.autoReplyRules)
    .values({
      workspace_id: WS,
      name: "Tagger",
      trigger_type: "keyword",
      trigger_config: { keywords: [{ value: "hi", match_type: "contains" }] },
      response_type: "text",
      response_config: { text: "hello", add_tags: ["vip", "lead"] },
      is_active: true,
      cooldown_seconds: 0,
      ...over,
    })
    .returning({ id: s.autoReplyRules.id });
  return r.id;
}

async function contactTagNames() {
  const rows = await db
    .select({ name: s.tags.name })
    .from(s.contactTags)
    .innerJoin(s.tags, eq(s.contactTags.tag_id, s.tags.id))
    .where(eq(s.contactTags.contact_id, CONTACT));
  return rows.map((r) => r.name).sort();
}

async function outgoingJobCount() {
  const r = await db.execute(sql`select count(*)::int as n from graphile_worker.jobs where task_identifier = 'outgoing-message'`);
  return Number((r.rows[0] as { n: number }).n);
}

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  ({ evaluateRules } = await import("./executor"));
  ({ closeQueue } = await import("@/lib/queue/client"));
  // Ensure the graphile_worker schema exists before beforeEach truncates its jobs table — this file
  // can run before any other graphile-touching test has lazily created it.
  const { makeWorkerUtils } = await import("graphile-worker");
  const utils = await makeWorkerUtils({ connectionString: process.env.DATABASE_URL! });
  await utils.migrate();
  await utils.release();
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.execute(sql`truncate table graphile_worker._private_jobs cascade`);
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.delete(s.ruleCooldowns);
  await db.insert(s.workspaces).values({ id: WS, name: "T", slug: `t-${WS}` });
  await db.insert(s.channels).values({
    id: CH, workspace_id: WS, platform: "facebook", platform_id: "PG-T", token_encrypted: "x", webhook_secret: "s", status: "active",
  });
  await db.insert(s.contacts).values({ id: CONTACT, workspace_id: WS });
  await db.insert(s.conversations).values({
    id: CONV, workspace_id: WS, channel_id: CH, contact_id: CONTACT, platform: "facebook", status: "open",
  });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.execute(sql`truncate table graphile_worker._private_jobs cascade`);
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await closeQueue();
});

describe.skipIf(!TEST_DB)("CRMTAG1 — rule add_tags", () => {
  it("tags the contact when a text rule fires (creating missing tags) and still sends the reply", async () => {
    await seedRule();
    const res = await evaluateRules({ ...baseInput });
    expect(res.outcome).toBe("fired");
    expect(await contactTagNames()).toEqual(["lead", "vip"]);
    expect(await outgoingJobCount()).toBe(1); // tagging is additive to the reply, not instead of it
    // tags were auto-created in the workspace
    expect(await db.$count(s.tags, eq(s.tags.workspace_id, WS))).toBe(2);
  });

  it("supports tag-only rules (response_type none): tags the contact, sends nothing", async () => {
    await seedRule({ response_type: "none", response_config: { add_tags: ["newsletter"] } });
    const res = await evaluateRules({ ...baseInput, eventKey: "evt-none-1" });
    expect(res.outcome).toBe("fired");
    expect(await contactTagNames()).toEqual(["newsletter"]);
    expect(await outgoingJobCount()).toBe(0);
  });

  it("is idempotent: re-firing does not duplicate the tag link", async () => {
    await seedRule();
    await evaluateRules({ ...baseInput });
    await evaluateRules({ ...baseInput });
    expect(await contactTagNames()).toEqual(["lead", "vip"]);
    const links = await db.select().from(s.contactTags).where(and(eq(s.contactTags.contact_id, CONTACT)));
    expect(links).toHaveLength(2);
  });
});

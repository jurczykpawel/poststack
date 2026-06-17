import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import { makeTestKey, makeClaims, type TestKey } from "@/lib/license/__fixtures__/keys";
import type { JwksKey } from "@/lib/license/format";

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let evaluateRules: typeof import("./executor").evaluateRules;
let gate: typeof import("@/lib/license/gate");
let jwks: typeof import("@/lib/license/jwks");
let closeQueue: typeof import("@/lib/queue/client").closeQueue;
let key: TestKey;

const WS = "ee510000-0000-4000-8000-0000000000d1";
const CH = "ee510000-0000-4000-8000-0000000000d2";
const CONTACT = "ee510000-0000-4000-8000-0000000000d3";
const CONV = "ee510000-0000-4000-8000-0000000000d4";

const baseInput = {
  workspaceId: WS,
  channelId: CH,
  platform: "facebook",
  conversationId: CONV,
  contactId: CONTACT,
  recipientPlatformId: "PSID-SEQ",
  text: "start",
  eventType: "message" as const,
};

function jwksFetch(keys: JwksKey[]): (url: string) => Promise<Response> {
  return async () => new Response(JSON.stringify({ keys }), { status: 200 });
}

async function licensePro() {
  const token = await key.sign(makeClaims({ kid: "kid-1", tier: "pro" }));
  await gate.setLicense(token, { fetchImpl: jwksFetch([key.jwk]) });
}

async function seedSequence(status = "active") {
  const [seq] = await db
    .insert(s.sequences)
    .values({ workspace_id: WS, name: "Drip", status: status as "active" | "draft" | "archived", steps: [{ type: "message", content: "hi" }] })
    .returning({ id: s.sequences.id });
  return seq.id;
}

async function seedSeqRule(sequenceId: string) {
  const [r] = await db
    .insert(s.autoReplyRules)
    .values({
      workspace_id: WS,
      name: "Enroll on start",
      trigger_type: "keyword",
      trigger_config: { keywords: [{ value: "start", match_type: "contains" }] },
      response_type: "sequence",
      response_config: { sequence_id: sequenceId },
      is_active: true,
      cooldown_seconds: 0,
    })
    .returning({ id: s.autoReplyRules.id });
  return r.id;
}

async function enrollmentCount(): Promise<number> {
  const r = await db.execute(sql`select count(*)::int as n from sequence_enrollments where channel_id = ${CH}`);
  return Number((r.rows[0] as { n: number }).n);
}
async function stepJobCount(): Promise<number> {
  const r = await db.execute(sql`select count(*)::int as n from graphile_worker.jobs where task_identifier = 'sequence-step'`);
  return Number((r.rows[0] as { n: number }).n);
}

beforeAll(async () => {
  if (!TEST_DB) return;
  key = await makeTestKey("kid-1");
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  ({ evaluateRules } = await import("./executor"));
  ({ closeQueue } = await import("@/lib/queue/client"));
  gate = await import("@/lib/license/gate");
  jwks = await import("@/lib/license/jwks");
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.execute(sql`truncate table graphile_worker._private_jobs cascade`);
  await db.delete(s.sequenceEnrollments).where(eq(s.sequenceEnrollments.channel_id, CH));
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.delete(s.ruleCooldowns);
  await db.delete(s.instanceLicense);
  gate.invalidateLicenseCache();
  jwks.__resetJwksCache();
  await db.insert(s.workspaces).values({ id: WS, name: "S", slug: `seq-${WS}` });
  await db.insert(s.channels).values({ id: CH, workspace_id: WS, platform: "facebook", platform_id: "PG-S", token_encrypted: "x", webhook_secret: "s", status: "active" });
  await db.insert(s.contacts).values({ id: CONTACT, workspace_id: WS });
  await db.insert(s.conversations).values({ id: CONV, workspace_id: WS, channel_id: CH, contact_id: CONTACT, platform: "facebook", status: "open" });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.execute(sql`truncate table graphile_worker._private_jobs cascade`);
  await db.delete(s.sequenceEnrollments).where(eq(s.sequenceEnrollments.channel_id, CH));
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.delete(s.instanceLicense);
  if (closeQueue) await closeQueue();
});

describe("trigger-driven sequence enrollment in the executor (real Postgres)", () => {
  it("enrolls the contact and schedules the first step when a sequence rule matches (licensed)", async () => {
    if (!TEST_DB) return;
    await licensePro();
    const seqId = await seedSequence();
    const ruleId = await seedSeqRule(seqId);

    const res = await evaluateRules(baseInput);

    expect(res.outcome).toBe("fired");
    expect(res.ruleId).toBe(ruleId);
    expect(await enrollmentCount()).toBe(1);
    expect(await stepJobCount()).toBe(1);
  });

  it("does not enroll twice — a re-fire of the same contact is an idempotent no-op", async () => {
    if (!TEST_DB) return;
    await licensePro();
    const seqId = await seedSequence();
    await seedSeqRule(seqId);

    await evaluateRules(baseInput);
    await db.execute(sql`truncate table graphile_worker._private_jobs cascade`); // clear the first step job

    const second = await evaluateRules(baseInput);
    expect(second.outcome).toBe("fired"); // rule still matches/fires
    expect(await enrollmentCount()).toBe(1); // but no duplicate enrollment
    expect(await stepJobCount()).toBe(0); // and nothing re-scheduled
  });

  it("falls through (does not enroll) on a free/unlicensed instance", async () => {
    if (!TEST_DB) return;
    const seqId = await seedSequence();
    await seedSeqRule(seqId);

    const res = await evaluateRules(baseInput);

    expect(res.ruleId).toBeNull(); // sequence rule skipped — no other rule to answer
    expect(await enrollmentCount()).toBe(0);
  });

  it("falls through when the target sequence is not active (draft)", async () => {
    if (!TEST_DB) return;
    await licensePro();
    const seqId = await seedSequence("draft");
    await seedSeqRule(seqId);

    const res = await evaluateRules(baseInput);

    expect(res.ruleId).toBeNull();
    expect(await enrollmentCount()).toBe(0);
  });
});

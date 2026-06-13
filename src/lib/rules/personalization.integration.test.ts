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

const WS = "ee500000-0000-0000-0000-0000000000d1";
const CH = "ee500000-0000-0000-0000-0000000000d2";
const CONTACT = "ee500000-0000-0000-0000-0000000000d3";
const CONV = "ee500000-0000-0000-0000-0000000000d4";

const baseInput = {
  workspaceId: WS,
  channelId: CH,
  conversationId: CONV,
  contactId: CONTACT,
  recipientPlatformId: "PSID-PERS",
  text: "hi there",
  eventType: "message" as const,
};

function jwksFetch(keys: JwksKey[]): (url: string) => Promise<Response> {
  return async () => new Response(JSON.stringify({ keys }), { status: 200 });
}

async function seedRule() {
  await db.insert(s.autoReplyRules).values({
    workspace_id: WS,
    name: "Greet",
    trigger_type: "keyword",
    trigger_config: { keywords: [{ value: "hi", match_type: "contains" }] },
    response_type: "text",
    response_config: { text: "Cześć {imie}! ({name})" },
    is_active: true,
    cooldown_seconds: 0,
  });
}

async function sentText(): Promise<string> {
  const r = await db.execute(
    sql`select pj.payload from graphile_worker.jobs j join graphile_worker._private_jobs pj on pj.id = j.id where j.task_identifier = 'outgoing-message'`,
  );
  return (r.rows[0] as { payload: { content: { text: string } } }).payload.content.text;
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
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.delete(s.ruleCooldowns);
  await db.delete(s.instanceLicense);
  gate.invalidateLicenseCache();
  jwks.__resetJwksCache();
  await db.insert(s.workspaces).values({ id: WS, name: "P", slug: `p-${WS}` });
  await db.insert(s.channels).values({
    id: CH, workspace_id: WS, platform: "facebook", platform_id: "PG-P", token_encrypted: "x", webhook_secret: "s", status: "active",
  });
  await db.insert(s.contacts).values({ id: CONTACT, workspace_id: WS, display_name: "Jan Kowalski" });
  await db.insert(s.conversations).values({
    id: CONV, workspace_id: WS, channel_id: CH, contact_id: CONTACT, platform: "facebook", status: "open",
  });
  await seedRule();
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.execute(sql`truncate table graphile_worker._private_jobs cascade`);
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.delete(s.instanceLicense);
  if (closeQueue) await closeQueue();
});

describe("personalization in the executor (real Postgres)", () => {
  it("strips placeholders safely on a free (unlicensed) instance — no leak", async () => {
    if (!TEST_DB) return;
    expect((await evaluateRules(baseInput)).ruleId).not.toBeNull();
    const text = await sentText();
    expect(text).toBe("Cześć! ()");
    expect(text).not.toContain("{imie}");
    expect(text).not.toContain("Jan"); // no personal data substituted without a license
  });

  it("substitutes the contact's name when licensed (pro)", async () => {
    if (!TEST_DB) return;
    const token = await key.sign(makeClaims({ kid: "kid-1", tier: "pro" }));
    await gate.setLicense(token, { fetchImpl: jwksFetch([key.jwk]) }); // warms cache + persists
    expect((await evaluateRules(baseInput)).ruleId).not.toBeNull();
    expect(await sentText()).toBe("Cześć Jan! (Jan Kowalski)");
  });
});

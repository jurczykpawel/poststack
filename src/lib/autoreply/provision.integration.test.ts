import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestKey, makeClaims, type TestKey } from "@/lib/license/__fixtures__/keys";
import type { JwksKey } from "@/lib/license/format";

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let provisionAutoReply: typeof import("./provision").provisionAutoReply;
let encryptTokens: typeof import("@/lib/crypto").encryptTokens;
let gate: typeof import("@/lib/license/gate");
let jwks: typeof import("@/lib/license/jwks");
let key: TestKey;

const WS = "a1b2c3d4-0000-0000-0000-00000000a701";

function jwksFetch(keys: JwksKey[]): (url: string) => Promise<Response> {
  return async () => new Response(JSON.stringify({ keys }), { status: 200 });
}
async function licensePro() {
  const token = await key.sign(makeClaims({ kid: "kid-1", tier: "pro" }));
  await gate.setLicense(token, { fetchImpl: jwksFetch([key.jwk]) });
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
  ({ provisionAutoReply } = await import("./provision"));
  ({ encryptTokens } = await import("@/lib/crypto"));
  gate = await import("@/lib/license/gate");
  jwks = await import("@/lib/license/jwks");
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.insert(s.workspaces).values({ id: WS, name: "AR", slug: `ar-${WS}` });
  await db.delete(s.instanceLicense);
  gate.invalidateLicenseCache();
  jwks.__resetJwksCache();
});

afterEach(() => {});

async function seedSequence(status = "active") {
  const [seq] = await db.insert(s.sequences)
    .values({ workspace_id: WS, name: "Drip", status: status as "active" | "draft" | "archived", steps: [{ type: "message", content: "hi" }] })
    .returning({ id: s.sequences.id });
  return seq!.id;
}

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.delete(s.instanceLicense);
  gate.invalidateLicenseCache();
  await db.$client.end();
});

/** Seed a channel + a sent delivery (provider_handle = media id) + an editorial post linked to it. */
async function seed(opts: { platform: "facebook" | "instagram" | "tiktok"; autoReply: unknown; mediaId?: string }) {
  const [ch] = await db
    .insert(s.channels)
    .values({
      workspace_id: WS,
      platform: opts.platform,
      platform_id: `acct-${Math.random()}`,
      connection_mode: "derived",
      status: "active",
      token_encrypted: encryptTokens({ access_token: "T" }),
      webhook_secret: "wh",
    })
    .returning({ id: s.channels.id });
  const [d] = await db
    .insert(s.deliveries)
    .values({
      workspace_id: WS,
      channel_id: ch!.id,
      format: "video",
      status: "sent",
      payload: { format: "video", media: [] },
      scheduled_at: new Date(),
      run_at: new Date(),
      provider_handle: opts.mediaId ?? "MEDIA_123",
    })
    .returning({ id: s.deliveries.id });
  const [p] = await db
    .insert(s.posts)
    .values({ workspace_id: WS, platform: opts.platform, delivery_id: d!.id, status: "published", auto_reply: opts.autoReply })
    .returning({ id: s.posts.id });
  return { channelId: ch!.id, deliveryId: d!.id, postId: p!.id };
}

const basicAutoReply = {
  keywords: [{ value: "info", matchType: "contains" }],
  dmText: "Here is the link!",
  replyMode: "dm",
};

describe("provisionAutoReply (real Postgres)", () => {
  it("creates a comment_keyword rule scoped to the published media id, and writes ruleId+status back", async () => {
    if (!TEST_DB) return;
    const { deliveryId, postId } = await seed({ platform: "instagram", autoReply: basicAutoReply, mediaId: "IG_MEDIA_9" });

    const r = await provisionAutoReply(deliveryId, WS);
    expect(r.status).toBe("active");

    const rule = await db.query.autoReplyRules.findFirst({ where: eq(s.autoReplyRules.id, r.ruleId!) });
    expect(rule!.workspace_id).toBe(WS);
    expect(rule!.trigger_type).toBe("comment_keyword");
    expect((rule!.trigger_config as { post_id?: string }).post_id).toBe("IG_MEDIA_9");
    expect((rule!.trigger_config as { keywords?: { value: string; match_type: string }[] }).keywords).toEqual([{ value: "info", match_type: "contains" }]);
    expect((rule!.response_config as { text?: string; reply_mode?: string }).text).toBe("Here is the link!");
    expect((rule!.response_config as { reply_mode?: string }).reply_mode).toBe("dm");

    // ruleId + status persisted back onto the post's auto_reply
    const post = await db.query.posts.findFirst({ where: eq(s.posts.id, postId) });
    const ar = post!.auto_reply as { ruleId?: string; status?: string };
    expect(ar.ruleId).toBe(r.ruleId);
    expect(ar.status).toBe("active");
  });

  it("is idempotent: re-running updates the SAME rule (no duplicate)", async () => {
    if (!TEST_DB) return;
    const { deliveryId } = await seed({ platform: "instagram", autoReply: basicAutoReply, mediaId: "IG_MEDIA_X" });
    const r1 = await provisionAutoReply(deliveryId, WS);
    const r2 = await provisionAutoReply(deliveryId, WS);
    expect(r2.ruleId).toBe(r1.ruleId);
    const all = await db.query.autoReplyRules.findMany({ where: eq(s.autoReplyRules.workspace_id, WS) });
    expect(all).toHaveLength(1);
  });

  it("skips a non-IG/FB platform (auto-reply is Meta-only)", async () => {
    if (!TEST_DB) return;
    const { deliveryId } = await seed({ platform: "tiktok", autoReply: basicAutoReply });
    const r = await provisionAutoReply(deliveryId, WS);
    expect(r.status).toBe("skipped_unsupported");
    const all = await db.query.autoReplyRules.findMany({ where: eq(s.autoReplyRules.workspace_id, WS) });
    expect(all).toHaveLength(0);
  });

  it("no-ops a post with no auto_reply", async () => {
    if (!TEST_DB) return;
    const { deliveryId } = await seed({ platform: "instagram", autoReply: null });
    const r = await provisionAutoReply(deliveryId, WS);
    expect(r.status).toBe("none");
  });

  it("skips (unlicensed) when the auto-reply uses a PRO feature the instance lacks (personalization)", async () => {
    if (!TEST_DB) return;
    // a personalization placeholder in dmText requires the `personalization` PRO feature
    const proAutoReply = { keywords: [{ value: "hi", matchType: "contains" }], dmText: "Cześć {imie}!", replyMode: "dm" };
    const { deliveryId, postId } = await seed({ platform: "instagram", autoReply: proAutoReply, mediaId: "IG_PRO" });
    const r = await provisionAutoReply(deliveryId, WS);
    expect(r.status).toBe("skipped_unlicensed");
    const all = await db.query.autoReplyRules.findMany({ where: eq(s.autoReplyRules.workspace_id, WS) });
    expect(all).toHaveLength(0);
    const post = await db.query.posts.findFirst({ where: eq(s.posts.id, postId) });
    expect((post!.auto_reply as { status?: string }).status).toBe("skipped_unlicensed");
  });

  // SEQTRIGGER1: a comment auto-reply can enroll the commenter into a drip sequence.
  it("provisions a sequence rule scoped to the media when responseType=sequence (licensed)", async () => {
    if (!TEST_DB) return;
    await licensePro();
    const seqId = await seedSequence();
    const seqAutoReply = { keywords: [{ value: "kurs", matchType: "contains" }], responseType: "sequence", sequenceId: seqId };
    const { deliveryId, postId } = await seed({ platform: "instagram", autoReply: seqAutoReply, mediaId: "IG_SEQ" });

    const r = await provisionAutoReply(deliveryId, WS);
    expect(r.status).toBe("active");

    const rule = await db.query.autoReplyRules.findFirst({ where: eq(s.autoReplyRules.id, r.ruleId!) });
    expect(rule!.trigger_type).toBe("comment_keyword");
    expect((rule!.trigger_config as { post_id?: string }).post_id).toBe("IG_SEQ");
    expect(rule!.response_type).toBe("sequence");
    expect((rule!.response_config as { sequence_id?: string }).sequence_id).toBe(seqId);

    const post = await db.query.posts.findFirst({ where: eq(s.posts.id, postId) });
    expect((post!.auto_reply as { status?: string }).status).toBe("active");
  });

  it("errors a sequence auto-reply pointing at a non-active sequence", async () => {
    if (!TEST_DB) return;
    await licensePro();
    const seqId = await seedSequence("draft");
    const seqAutoReply = { keywords: [{ value: "kurs", matchType: "contains" }], responseType: "sequence", sequenceId: seqId };
    const { deliveryId } = await seed({ platform: "instagram", autoReply: seqAutoReply, mediaId: "IG_SEQ_DRAFT" });

    const r = await provisionAutoReply(deliveryId, WS);
    expect(r.status).toBe("error");
    const all = await db.query.autoReplyRules.findMany({ where: eq(s.autoReplyRules.workspace_id, WS) });
    expect(all).toHaveLength(0);
  });

  it("skips (unlicensed) a sequence auto-reply on a free instance", async () => {
    if (!TEST_DB) return;
    const seqId = await seedSequence();
    const seqAutoReply = { keywords: [{ value: "kurs", matchType: "contains" }], responseType: "sequence", sequenceId: seqId };
    const { deliveryId } = await seed({ platform: "instagram", autoReply: seqAutoReply, mediaId: "IG_SEQ_FREE" });

    const r = await provisionAutoReply(deliveryId, WS);
    expect(r.status).toBe("skipped_unlicensed");
  });
});

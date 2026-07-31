import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type { JobHelpers } from "graphile-worker";
import { eq, sql } from "drizzle-orm";
import { licenseInstance } from "@/lib/license/__fixtures__/license-instance";

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let schema: typeof import("@/db/schema");
let encryptTokens: typeof import("@/lib/crypto").encryptTokens;
let drainChannel: typeof import("@/lib/channels/drain").drainChannel;
let errs: typeof import("@/lib/providers/errors");
let processPublish: typeof import("./publish-worker").processPublish;
let stuckSendingSweep: typeof import("./publish-worker").stuckSendingSweep;
let seedWorkspace: typeof import("../../../tests/helpers/workspace").seedWorkspace;
let WS = "";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY = "test-encryption-key-at-least-32-characters-long";
  process.env.JWT_SECRET ??= "test-secret-at-least-32-characters-long";
  process.env.APP_URL ??= "http://localhost:3000";
  process.env.CRON_SECRET ??= "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  schema = await import("@/db/schema");
  ({ encryptTokens } = await import("@/lib/crypto"));
  ({ drainChannel } = await import("@/lib/channels/drain"));
  errs = await import("@/lib/providers/errors");
  ({ processPublish, stuckSendingSweep } = await import("./publish-worker"));
  ({ seedWorkspace } = await import("../../../tests/helpers/workspace"));
  WS = await seedWorkspace(db, schema, { slug: `pub-${Date.now()}` });
  // first_comment + auto_story are PRO (publishing area) — license the instance so the enqueue
  // tests exercise the licensed path; the negative (toggle-off) tests pass regardless.
  await licenseInstance();
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.execute(sql.raw("truncate table graphile_worker._private_jobs cascade"));
  await db.delete(schema.workspaces).where(eq(schema.workspaces.id, WS));
  await db.$client.end();
});

beforeEach(async () => {
  if (!TEST_DB) return;
  // FK-safe wipe of the per-test rows (keep the workspace).
  await db.delete(schema.autoReplyRules).where(eq(schema.autoReplyRules.workspace_id, WS));
  await db.delete(schema.posts).where(eq(schema.posts.workspace_id, WS));
  await db.delete(schema.deliveries).where(eq(schema.deliveries.workspace_id, WS));
  await db.delete(schema.content).where(eq(schema.content.workspace_id, WS));
  await db.delete(schema.events).where(eq(schema.events.workspace_id, WS));
  await db.delete(schema.media).where(eq(schema.media.workspace_id, WS));
  await db.delete(schema.channels).where(eq(schema.channels.workspace_id, WS));
  await db.execute(sql.raw("truncate table graphile_worker._private_jobs cascade"));
});
afterEach(() => vi.unstubAllGlobals());

const helpers = { logger: { info() {}, error() {} } } as unknown as JobHelpers;

async function scenario(channelStatus: "active" | "needs_reauth" = "active") {
  const [c] = await db
    .insert(schema.channels)
    .values({
      workspace_id: WS,
      platform: "tiktok", // a registered publish provider that isn't gated by inbound webhook routing
      platform_id: `ACCT-${Math.random()}`,
      connection_mode: "manual_token",
      status: channelStatus,
      token_encrypted: encryptTokens({ access_token: "T" }),
      webhook_secret: "wh",
    })
    .returning();
  const [m] = await db
    .insert(schema.media)
    .values({ workspace_id: WS, checksum: `c${Math.random()}`, storage_key: "k", url: "https://cdn/x.mp4", kind: "video" })
    .returning();
  const [p] = await db
    .insert(schema.deliveries)
    .values({
      workspace_id: WS,
      channel_id: c!.id,
      format: "video",
      status: "scheduled",
      payload: { format: "video", media: [{ mediaId: m!.id }], caption: "hi" },
      scheduled_at: new Date(),
      run_at: new Date(),
    })
    .returning();
  return { channelId: c!.id, postId: p!.id };
}
/**
 * AIDISC2: merge into the delivery payload what `publishPost()` puts there once a declaration resolves.
 * The audit trail is deliberately built from the payload — the object actually sent — rather than
 * recomputed from the post row, so a test that only sets the post's columns proves nothing about it.
 * Keeps the scenario's real media reference so the publish still reaches its success branch.
 */
async function withDisclosurePayload(
  deliveryId: string,
  aiDisclosure: { level: string; levelSource?: string; note: string | null; noteSource?: string } | null,
  aiDisclosed?: boolean,
) {
  const existing = (await db.query.deliveries.findFirst({ where: eq(schema.deliveries.id, deliveryId) }))!;
  const payload = existing.payload as Record<string, unknown>;
  await db
    .update(schema.deliveries)
    .set({
      payload: {
        ...payload,
        options: {
          ...((payload.options as Record<string, unknown>) ?? {}),
          ...(aiDisclosure ? { aiDisclosure: { levelSource: "post", noteSource: "post", ...aiDisclosure } } : {}),
          ...(aiDisclosed !== undefined ? { aiDisclosed } : {}),
        },
      },
    })
    .where(eq(schema.deliveries.id, deliveryId));
}

const status = async (id: string) =>
  (await db.query.deliveries.findFirst({ where: eq(schema.deliveries.id, id) }))!.status;

async function publishJobByKey(jobKey: string): Promise<{ run_at: string } | null> {
  const r = await db.execute(
    sql`select run_at from graphile_worker.jobs where task_identifier='publish' and key=${jobKey}`,
  );
  return (r.rows[0] as { run_at: string } | undefined) ?? null;
}

describe("publish worker (AUD27)", () => {
  it("scheduled + healthy -> sent, stores provider_handle", async () => {
    if (!TEST_DB) return;
    const { postId } = await scenario();
    const spy = vi.spyOn((await import("@/lib/providers/tiktok")).tiktokProvider, "publish").mockResolvedValue({ providerHandle: "post_xyz" });
    try {
      await processPublish({ postId }, helpers);
      expect(await status(postId)).toBe("sent");
      const row = await db.query.deliveries.findFirst({ where: eq(schema.deliveries.id, postId) });
      expect(row!.provider_handle).toBe("post_xyz");
    } finally {
      spy.mockRestore();
    }
  });

  it("UNIFY P2.2: publishing an IG post with auto_reply provisions a comment→DM rule scoped to the media id", async () => {
    if (!TEST_DB) return;
    const [c] = await db
      .insert(schema.channels)
      .values({ workspace_id: WS, platform: "instagram", platform_id: `IG-${Math.random()}`, connection_mode: "derived", status: "active", token_encrypted: encryptTokens({ access_token: "T" }), webhook_secret: "wh" })
      .returning();
    const [m] = await db
      .insert(schema.media)
      .values({ workspace_id: WS, checksum: `c${Math.random()}`, storage_key: "k", url: "https://cdn/x.mp4", kind: "video" })
      .returning();
    const [d] = await db
      .insert(schema.deliveries)
      .values({ workspace_id: WS, channel_id: c!.id, format: "video", status: "scheduled", payload: { format: "video", media: [{ mediaId: m!.id }], caption: "hi" }, scheduled_at: new Date(), run_at: new Date() })
      .returning();
    // editorial post linked to the delivery, carrying the auto-reply config
    await db.insert(schema.posts).values({
      workspace_id: WS,
      platform: "instagram",
      delivery_id: d!.id,
      status: "scheduled",
      auto_reply: { keywords: [{ value: "link", matchType: "contains" }], dmText: "Here you go!", replyMode: "dm" },
    });

    const spy = vi.spyOn((await import("@/lib/providers/meta")).metaProvider, "publish").mockResolvedValue({ providerHandle: "IG_MEDIA_777" });
    try {
      await processPublish({ postId: d!.id }, helpers);
      expect(await status(d!.id)).toBe("sent");
      const rule = await db.query.autoReplyRules.findFirst({ where: eq(schema.autoReplyRules.workspace_id, WS) });
      expect(rule!.trigger_type).toBe("comment_keyword");
      expect((rule!.trigger_config as { post_id?: string }).post_id).toBe("IG_MEDIA_777");
      expect(rule!.channel_id).toBe(c!.id);
    } finally {
      spy.mockRestore();
    }
  });

  it("channel needs_reauth -> post held (not attempted)", async () => {
    if (!TEST_DB) return;
    const { postId } = await scenario("needs_reauth");
    await processPublish({ postId }, helpers);
    expect(await status(postId)).toBe("held");
  });

  it("a pre-mutation media failure (missing media) fails cleanly without calling publish [PSA2]", async () => {
    if (!TEST_DB) return;
    const tt = (await import("@/lib/providers/tiktok")).tiktokProvider;
    const [c] = await db
      .insert(schema.channels)
      .values({ workspace_id: WS, platform: "tiktok", platform_id: `A2-${Math.random()}`, connection_mode: "manual_token", status: "active", token_encrypted: encryptTokens({ access_token: "T" }), webhook_secret: "wh" })
      .returning();
    const [p] = await db
      .insert(schema.deliveries)
      .values({ workspace_id: WS, channel_id: c!.id, format: "video", status: "scheduled", payload: { format: "video", media: [{ mediaId: crypto.randomUUID() }] }, scheduled_at: new Date(), run_at: new Date() })
      .returning();
    const spy = vi.spyOn(tt, "publish");
    try {
      await processPublish({ postId: p!.id }, helpers);
      expect(await status(p!.id)).toBe("failed");
      expect(spy).not.toHaveBeenCalled(); // never reached the external publish
    } finally {
      spy.mockRestore();
    }
  });

  it("dead token during publish -> channel needs_reauth + post held", async () => {
    if (!TEST_DB) return;
    const { postId, channelId } = await scenario();
    const tt = (await import("@/lib/providers/tiktok")).tiktokProvider;
    const spy = vi.spyOn(tt, "publish").mockRejectedValue(new errs.TokenInvalidError("token dead"));
    try {
      await processPublish({ postId }, helpers);
      expect(await status(postId)).toBe("held");
      const ch = await db.query.channels.findFirst({ where: eq(schema.channels.id, channelId) });
      expect(ch!.status).toBe("needs_reauth");
    } finally {
      spy.mockRestore();
    }
  });

  it("retry after a crash mid-send (status 'sending', no reconcile) -> unknown", async () => {
    if (!TEST_DB) return;
    const { postId } = await scenario();
    await db.update(schema.deliveries).set({ status: "sending" }).where(eq(schema.deliveries.id, postId));
    await processPublish({ postId }, helpers);
    expect(await status(postId)).toBe("unknown");
  });

  async function linkEditorial(
    deliveryId: string,
    postStatus = "scheduled",
    extra: Partial<typeof schema.posts.$inferInsert> = {},
  ) {
    const [content] = await db.insert(schema.content).values({ workspace_id: WS, title: "x" }).returning();
    const [p] = await db
      .insert(schema.posts)
      .values({ workspace_id: WS, content_id: content!.id, platform: "instagram", status: postStatus, delivery_id: deliveryId, ...extra })
      .returning();
    return p!.id;
  }
  const editorialStatus = async (deliveryId: string) =>
    (await db.query.posts.findFirst({ where: eq(schema.posts.delivery_id, deliveryId) }))!.status;
  const events = async (subjectId: string) =>
    (await db.query.events.findMany({ where: eq(schema.events.subject_id, subjectId) })).map((e) => e.type);

  it("an 'unknown' landing emits an event and reflects editorial as needs_attention [PSA3]", async () => {
    if (!TEST_DB) return;
    const { postId } = await scenario();
    const editorialId = await linkEditorial(postId);
    await db.update(schema.deliveries).set({ status: "sending" }).where(eq(schema.deliveries.id, postId));
    await processPublish({ postId }, helpers);
    expect(await status(postId)).toBe("unknown");
    expect(await editorialStatus(postId)).toBe("needs_attention");
    // APIFIX1: the event is keyed to the editorial post, with the delivery id in the payload.
    expect(await events(editorialId)).toContain("post.unknown");
    const ev = (await db.query.events.findMany({ where: eq(schema.events.subject_id, editorialId) })).find((e) => e.type === "post.unknown");
    expect((ev!.payload as { deliveryId?: string }).deliveryId).toBe(postId);
  });

  it("post.published is keyed to the editorial post id, with the delivery id in the payload [APIFIX1]", async () => {
    if (!TEST_DB) return;
    const { postId } = await scenario();
    const editorialId = await linkEditorial(postId);
    const spy = vi.spyOn((await import("@/lib/providers/tiktok")).tiktokProvider, "publish").mockResolvedValue({ providerHandle: "post_abc" });
    try {
      await processPublish({ postId }, helpers);
      expect(await status(postId)).toBe("sent");
      const published = (await db.query.events.findMany({ where: eq(schema.events.subject_id, editorialId) })).find((e) => e.type === "post.published");
      expect(published).toBeTruthy(); // subject id resolves via GET /posts/{id}
      expect(published!.subject_type).toBe("post");
      expect((published!.payload as { deliveryId?: string }).deliveryId).toBe(postId);
      // and nothing was emitted under the delivery id
      const underDelivery = (await db.query.events.findMany({ where: eq(schema.events.subject_id, postId) })).filter((e) => e.type.startsWith("post."));
      expect(underDelivery).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  // ── AIDISC1: the ai_disclosure_sent audit trail written onto the editorial post at publish ────
  it("published post's ai_disclosure_sent records what actually went out, from the post's own declared level [AIDISC1]", async () => {
    if (!TEST_DB) return;
    const { postId } = await scenario(); // channel platform = tiktok
    const editorialId = await linkEditorial(postId, "scheduled", {
      platform: "tiktok",
      ai_disclosure: "ai_generated",
      ai_disclosure_note: "This video was made with AI.",
    });
    await withDisclosurePayload(postId, { level: "ai_generated", note: "This video was made with AI." }, true);
    const spy = vi
      .spyOn((await import("@/lib/providers/tiktok")).tiktokProvider, "publish")
      .mockResolvedValue({ providerHandle: "post_disc1" });
    try {
      await processPublish({ postId }, helpers);
      expect(await status(postId)).toBe("sent");
      const row = await db.query.posts.findFirst({ where: eq(schema.posts.id, editorialId) });
      const sent = row!.ai_disclosure_sent as Record<string, unknown>;
      expect(sent).toMatchObject({
        level: "ai_generated",
        platform: "tiktok",
        field: "post_info.is_aigc",
        value: true,
        supported: true,
        note: "This video was made with AI.",
      });
      expect(typeof sent.reason).toBe("string");
      expect(typeof sent.at).toBe("string");
      expect(new Date(sent.at as string).toISOString()).toBe(sent.at); // a real ISO timestamp
    } finally {
      spy.mockRestore();
    }
  });

  it("ai_disclosure 'none' records that the platform HAS a field we deliberately left unset, with a null note", async () => {
    if (!TEST_DB) return;
    const { postId } = await scenario();
    const editorialId = await linkEditorial(postId, "scheduled", {
      platform: "tiktok",
      ai_disclosure: "none",
      // A stray note should never surface once the level is 'none'.
      ai_disclosure_note: "leftover text",
    });
    const spy = vi
      .spyOn((await import("@/lib/providers/tiktok")).tiktokProvider, "publish")
      .mockResolvedValue({ providerHandle: "post_disc2" });
    try {
      await processPublish({ postId }, helpers);
      const row = await db.query.posts.findFirst({ where: eq(schema.posts.id, editorialId) });
      const sent = row!.ai_disclosure_sent as Record<string, unknown>;
      // `value: null` = nothing was sent (nothing was declared), while `supported: true` + a field name
      // still prove the platform offers one — the audit trail keeps "no field exists" and "we chose not
      // to set the field" apart. `consistent` holds because sending nothing is exactly what was required.
      expect(sent).toMatchObject({
        level: "none",
        platform: "tiktok",
        field: "post_info.is_aigc",
        value: null,
        sentFlag: null,
        consistent: true,
        supported: true,
        note: null,
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("a platform with no native disclosure field records supported=false, field=null, value=null", async () => {
    if (!TEST_DB) return;
    const { postId } = await scenario(); // still delivers via the tiktok provider (mocked)
    const editorialId = await linkEditorial(postId, "scheduled", {
      platform: "facebook", // no AI-disclosure API field exists for Facebook
      ai_disclosure: "ai_assisted",
      ai_disclosure_note: "Partially AI-assisted.",
    });
    // Facebook has no native field, so publishPost emits the audit object but no `aiDisclosed` flag.
    await withDisclosurePayload(postId, { level: "ai_assisted", note: "Partially AI-assisted." });
    const spy = vi
      .spyOn((await import("@/lib/providers/tiktok")).tiktokProvider, "publish")
      .mockResolvedValue({ providerHandle: "post_disc3" });
    try {
      await processPublish({ postId }, helpers);
      const row = await db.query.posts.findFirst({ where: eq(schema.posts.id, editorialId) });
      const sent = row!.ai_disclosure_sent as Record<string, unknown>;
      expect(sent).toMatchObject({
        level: "ai_assisted",
        platform: "facebook",
        field: null,
        value: null,
        supported: false,
        note: "Partially AI-assisted.",
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("a failure building the ai_disclosure_sent audit trail never loses the publish result, and is logged [best-effort]", async () => {
    if (!TEST_DB) return;
    const { postId } = await scenario();
    await linkEditorial(postId, "scheduled", { platform: "tiktok", ai_disclosure: "ai_generated" });
    const spy = vi
      .spyOn((await import("@/lib/providers/tiktok")).tiktokProvider, "publish")
      .mockResolvedValue({ providerHandle: "post_disc_fail" });
    const findFirstSpy = vi.spyOn(db.query.posts, "findFirst").mockRejectedValueOnce(new Error("boom"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await processPublish({ postId }, helpers);
      expect(await status(postId)).toBe("sent"); // the publish result is preserved despite the audit failure
      expect(errSpy).toHaveBeenCalled(); // the failure was logged, not silently swallowed
    } finally {
      spy.mockRestore();
      findFirstSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  // The evidence record has to be an OBSERVATION, not just a recomputation of our own policy — these
  // two assert the difference. `value` is what the rule requires, `sentFlag` is what the outgoing
  // request actually carried, and `consistent` is the tripwire that catches the plumbing silently
  // dropping the flag while the audit trail keeps happily claiming the field was set.
  it("records the flag observed in the outgoing request, and marks it consistent with the rule [AIDISC1]", async () => {
    if (!TEST_DB) return;
    const { postId } = await scenario();
    const editorialId = await linkEditorial(postId, "scheduled", { platform: "tiktok", ai_disclosure: "ai_generated" });
    await withDisclosurePayload(postId, { level: "ai_generated", note: null }, true);
    const spy = vi
      .spyOn((await import("@/lib/providers/tiktok")).tiktokProvider, "publish")
      .mockResolvedValue({ providerHandle: "post_disc_obs" });
    try {
      await processPublish({ postId }, helpers);
      const row = await db.query.posts.findFirst({ where: eq(schema.posts.id, editorialId) });
      expect(row!.ai_disclosure_sent).toMatchObject({ value: true, sentFlag: true, consistent: true });
    } finally {
      spy.mockRestore();
    }
  });

  it("flags inconsistency when the request carried no flag but the rule required one [AIDISC1]", async () => {
    if (!TEST_DB) return;
    const { postId } = await scenario();
    const editorialId = await linkEditorial(postId, "scheduled", { platform: "tiktok", ai_disclosure: "ai_generated" });
    // The declaration resolved and rode along, but the normalized flag never made it into the request —
    // exactly the plumbing drift the audit trail has to expose rather than paper over.
    await withDisclosurePayload(postId, { level: "ai_generated", note: null });
    const spy = vi
      .spyOn((await import("@/lib/providers/tiktok")).tiktokProvider, "publish")
      .mockResolvedValue({ providerHandle: "post_disc_drift" });
    try {
      await processPublish({ postId }, helpers);
      const row = await db.query.posts.findFirst({ where: eq(schema.posts.id, editorialId) });
      // Records the truth — nothing was sent — instead of asserting the rule's value as fact.
      expect(row!.ai_disclosure_sent).toMatchObject({ value: true, sentFlag: null, consistent: false });
    } finally {
      spy.mockRestore();
    }
  });

  it("a held delivery reflects editorial as held; drain reflects it back to scheduled [PSA3]", async () => {
    if (!TEST_DB) return;
    const { postId, channelId } = await scenario("needs_reauth");
    await linkEditorial(postId);
    await processPublish({ postId }, helpers);
    expect(await status(postId)).toBe("held");
    expect(await editorialStatus(postId)).toBe("held");

    await db.update(schema.channels).set({ status: "active" }).where(eq(schema.channels.id, channelId));
    await drainChannel(channelId);
    expect(await status(postId)).toBe("scheduled");
    expect(await editorialStatus(postId)).toBe("scheduled");
  });

  it("stuckSendingSweep surfaces deliveries stuck in 'sending' past the window, leaving fresh ones [PSA3]", async () => {
    if (!TEST_DB) return;
    const { postId: stuck, channelId } = await scenario();
    const stuckEditorialId = await linkEditorial(stuck);
    await db
      .update(schema.deliveries)
      .set({ status: "sending", attempt_started_at: new Date(Date.now() - 60 * 60 * 1000) })
      .where(eq(schema.deliveries.id, stuck));
    const [freshRow] = await db
      .insert(schema.deliveries)
      .values({ workspace_id: WS, channel_id: channelId, format: "video", status: "sending", payload: { format: "video", media: [] }, scheduled_at: new Date(), run_at: new Date(), attempt_started_at: new Date() })
      .returning();
    const fresh = freshRow!.id;

    const n = await stuckSendingSweep();
    expect(n).toBeGreaterThanOrEqual(1);
    expect(await status(stuck)).toBe("unknown");
    expect(await editorialStatus(stuck)).toBe("needs_attention");
    expect(await events(stuckEditorialId)).toContain("post.unknown"); // APIFIX1: keyed to editorial post
    expect(await status(fresh)).toBe("sending"); // too recent to sweep
  });

  it("out of per-minute budget → releases the claim + re-enqueues with a future runAt [PSA14]", async () => {
    if (!TEST_DB) return;
    const { postId, channelId } = await scenario();
    await db.insert(schema.channelRateState).values({ channel_id: channelId, tokens: 0 });
    const t0 = Date.now();
    await expect(processPublish({ postId }, helpers)).resolves.toBeUndefined();
    expect(await status(postId)).toBe("scheduled");
    const job = await publishJobByKey(`publish:${postId}`);
    expect(job).toBeTruthy();
    expect(new Date(job!.run_at).getTime()).toBeGreaterThan(t0);
  });

  it("a delivery that can't be claimed consumes no rate-limit token [PSA14]", async () => {
    if (!TEST_DB) return;
    const { postId, channelId } = await scenario();
    await db.update(schema.deliveries).set({ status: "held" }).where(eq(schema.deliveries.id, postId));
    await processPublish({ postId }, helpers);
    const rate = await db.query.channelRateState.findFirst({ where: eq(schema.channelRateState.channel_id, channelId) });
    expect(rate).toBeUndefined();
  });

  it("a pre-commit transient error resets to scheduled + re-enqueues [PSA36]", async () => {
    if (!TEST_DB) return;
    const { postId } = await scenario();
    const tt = (await import("@/lib/providers/tiktok")).tiktokProvider;
    const spy = vi.spyOn(tt, "publish").mockRejectedValue(new errs.TransientError("first-step 503", "pre_commit"));
    try {
      const t0 = Date.now();
      await expect(processPublish({ postId }, helpers)).resolves.toBeUndefined();
      expect(await status(postId)).toBe("scheduled");
      const job = await publishJobByKey(`publish:${postId}`);
      expect(job).toBeTruthy();
      expect(new Date(job!.run_at).getTime()).toBeGreaterThan(t0);
    } finally {
      spy.mockRestore();
    }
  });

  it("a pre-commit rate-limit honours retryAfter when re-enqueuing [PSA36]", async () => {
    if (!TEST_DB) return;
    const { postId } = await scenario();
    const tt = (await import("@/lib/providers/tiktok")).tiktokProvider;
    const spy = vi.spyOn(tt, "publish").mockRejectedValue(new errs.RateLimitedError("429", 120, "pre_commit"));
    try {
      const t0 = Date.now();
      await processPublish({ postId }, helpers);
      expect(await status(postId)).toBe("scheduled");
      const job = await publishJobByKey(`publish:${postId}`);
      expect(new Date(job!.run_at).getTime()).toBeGreaterThan(t0 + 100_000);
    } finally {
      spy.mockRestore();
    }
  });

  it("a commit-uncertain transient stays 'sending' → 'unknown' on retry (PSA2) [PSA36]", async () => {
    if (!TEST_DB) return;
    const { postId } = await scenario();
    const tt = (await import("@/lib/providers/tiktok")).tiktokProvider;
    const spy = vi.spyOn(tt, "publish").mockRejectedValue(new errs.TransientError("final-step 503"));
    try {
      await expect(processPublish({ postId }, helpers)).rejects.toThrow();
      expect(await status(postId)).toBe("sending");
    } finally {
      spy.mockRestore();
    }
    await processPublish({ postId }, helpers);
    expect(await status(postId)).toBe("unknown");
  });

  // ── FIRSTCOMMENT1: auto first-comment on publish ────────────────────────────────────────────
  // Capture the enqueue at the queue boundary (version-independent — the graphile `jobs` view does
  // not expose the payload column) and skip the real add so no stray job leaks into later suites.
  async function spyFirstCommentEnqueue() {
    const qc = await import("@/lib/queue/client");
    return vi.spyOn(qc, "addJob").mockResolvedValue(undefined);
  }
  function firstCommentCall(spy: ReturnType<typeof vi.fn>) {
    const call = spy.mock.calls.find((c) => c[0] === "outgoing-first-comment");
    return call ? { payload: call[1], opts: call[2] } : null;
  }

  function storyCall(spy: ReturnType<typeof vi.fn>) {
    const call = spy.mock.calls.find((c) => c[0] === "publish-story");
    return call ? { payload: call[1], opts: call[2] } : null;
  }

  async function igScenario(
    opts: {
      defaultFirstComment?: string | null;
      firstCommentOverride?: string;
      defaultAutoStory?: boolean;
      autoStoryOverride?: boolean;
    } = {},
  ) {
    const [c] = await db
      .insert(schema.channels)
      .values({
        workspace_id: WS,
        platform: "instagram",
        platform_id: `IGF-${Math.random()}`,
        connection_mode: "derived",
        status: "active",
        token_encrypted: encryptTokens({ access_token: "T" }),
        webhook_secret: "wh",
        default_first_comment: opts.defaultFirstComment ?? null,
        default_auto_story: opts.defaultAutoStory ?? false,
      })
      .returning();
    const [m] = await db
      .insert(schema.media)
      .values({ workspace_id: WS, checksum: `c${Math.random()}`, storage_key: "k", url: "https://cdn/x.mp4", kind: "video" })
      .returning();
    const payload: Record<string, unknown> = { format: "video", media: [{ mediaId: m!.id }], caption: "hi" };
    if (opts.firstCommentOverride !== undefined) payload.firstComment = opts.firstCommentOverride;
    if (opts.autoStoryOverride !== undefined) payload.autoStory = opts.autoStoryOverride;
    const [p] = await db
      .insert(schema.deliveries)
      .values({ workspace_id: WS, channel_id: c!.id, format: "video", status: "scheduled", payload, scheduled_at: new Date(), run_at: new Date() })
      .returning();
    return { channelId: c!.id, postId: p!.id };
  }

  it("enqueues a first-comment keyed to the publish handle when the channel has a default", async () => {
    if (!TEST_DB) return;
    const { channelId, postId } = await igScenario({ defaultFirstComment: "Link in comments 👇" });
    const enqueue = await spyFirstCommentEnqueue();
    const spy = vi.spyOn((await import("@/lib/providers/meta")).metaProvider, "publish").mockResolvedValue({ providerHandle: "IG_MEDIA_1" });
    try {
      await processPublish({ postId }, helpers);
      expect(await status(postId)).toBe("sent");
      const call = firstCommentCall(enqueue as unknown as ReturnType<typeof vi.fn>);
      expect(call?.payload).toEqual({ channelId, postId: "IG_MEDIA_1", text: "Link in comments 👇", idempotencyKey: `first-comment:${postId}` });
      expect(call?.opts).toEqual({ jobKey: `first-comment:${postId}` });
    } finally {
      spy.mockRestore();
      enqueue.mockRestore();
    }
  });

  it("per-post firstComment override beats the channel default", async () => {
    if (!TEST_DB) return;
    const { postId } = await igScenario({ defaultFirstComment: "channel default", firstCommentOverride: "per-post wins" });
    const enqueue = await spyFirstCommentEnqueue();
    const spy = vi.spyOn((await import("@/lib/providers/meta")).metaProvider, "publish").mockResolvedValue({ providerHandle: "IG_MEDIA_2" });
    try {
      await processPublish({ postId }, helpers);
      const call = firstCommentCall(enqueue as unknown as ReturnType<typeof vi.fn>);
      expect((call?.payload as { text: string }).text).toBe("per-post wins");
    } finally {
      spy.mockRestore();
      enqueue.mockRestore();
    }
  });

  it("does not enqueue a first-comment when neither default nor override is set", async () => {
    if (!TEST_DB) return;
    const { postId } = await igScenario();
    const enqueue = await spyFirstCommentEnqueue();
    const spy = vi.spyOn((await import("@/lib/providers/meta")).metaProvider, "publish").mockResolvedValue({ providerHandle: "IG_MEDIA_3" });
    try {
      await processPublish({ postId }, helpers);
      expect(await status(postId)).toBe("sent");
      expect(firstCommentCall(enqueue as unknown as ReturnType<typeof vi.fn>)).toBeNull();
    } finally {
      spy.mockRestore();
      enqueue.mockRestore();
    }
  });

  // ── STORY1: auto-Story on publish ───────────────────────────────────────────────────────────
  it("enqueues a publish-story keyed to the delivery when the channel default is on", async () => {
    if (!TEST_DB) return;
    const { channelId, postId } = await igScenario({ defaultAutoStory: true });
    const enqueue = await spyFirstCommentEnqueue();
    const spy = vi.spyOn((await import("@/lib/providers/meta")).metaProvider, "publish").mockResolvedValue({ providerHandle: "IG_MEDIA_S1" });
    try {
      await processPublish({ postId }, helpers);
      expect(await status(postId)).toBe("sent");
      const call = storyCall(enqueue as unknown as ReturnType<typeof vi.fn>);
      expect(call?.payload).toEqual({ channelId, deliveryId: postId, idempotencyKey: `auto-story:${postId}` });
      expect(call?.opts).toEqual({ jobKey: `auto-story:${postId}` });
    } finally {
      spy.mockRestore();
      enqueue.mockRestore();
    }
  });

  it("per-post autoStory=true overrides a channel default of off", async () => {
    if (!TEST_DB) return;
    const { postId } = await igScenario({ defaultAutoStory: false, autoStoryOverride: true });
    const enqueue = await spyFirstCommentEnqueue();
    const spy = vi.spyOn((await import("@/lib/providers/meta")).metaProvider, "publish").mockResolvedValue({ providerHandle: "IG_MEDIA_S2" });
    try {
      await processPublish({ postId }, helpers);
      expect(storyCall(enqueue as unknown as ReturnType<typeof vi.fn>)).not.toBeNull();
    } finally {
      spy.mockRestore();
      enqueue.mockRestore();
    }
  });

  it("per-post autoStory=false overrides a channel default of on", async () => {
    if (!TEST_DB) return;
    const { postId } = await igScenario({ defaultAutoStory: true, autoStoryOverride: false });
    const enqueue = await spyFirstCommentEnqueue();
    const spy = vi.spyOn((await import("@/lib/providers/meta")).metaProvider, "publish").mockResolvedValue({ providerHandle: "IG_MEDIA_S3" });
    try {
      await processPublish({ postId }, helpers);
      expect(storyCall(enqueue as unknown as ReturnType<typeof vi.fn>)).toBeNull();
    } finally {
      spy.mockRestore();
      enqueue.mockRestore();
    }
  });

  it("does not enqueue a publish-story when auto-story is off (no default, no override)", async () => {
    if (!TEST_DB) return;
    const { postId } = await igScenario();
    const enqueue = await spyFirstCommentEnqueue();
    const spy = vi.spyOn((await import("@/lib/providers/meta")).metaProvider, "publish").mockResolvedValue({ providerHandle: "IG_MEDIA_S4" });
    try {
      await processPublish({ postId }, helpers);
      expect(await status(postId)).toBe("sent");
      expect(storyCall(enqueue as unknown as ReturnType<typeof vi.fn>)).toBeNull();
    } finally {
      spy.mockRestore();
      enqueue.mockRestore();
    }
  });

  // PRO gate: first_comment + auto_story are publishing-area PRO features. On a FREE instance NEITHER
  // fires even with the toggles on — the server is the authority, not a stale stored toggle.
  it("does NOT enqueue first-comment or auto-story on a free (unlicensed) instance, toggles on", async () => {
    if (!TEST_DB) return;
    const gate = await import("@/lib/license/gate");
    const { channelId, postId } = await igScenario({ defaultFirstComment: "Link 👇", defaultAutoStory: true });
    const enqueue = await spyFirstCommentEnqueue();
    const spy = vi.spyOn((await import("@/lib/providers/meta")).metaProvider, "publish").mockResolvedValue({ providerHandle: "IG_MEDIA_FREE" });
    try {
      await gate.clearLicense(); // revert to free
      await processPublish({ postId }, helpers);
      expect(await status(postId)).toBe("sent"); // the post still publishes
      expect(firstCommentCall(enqueue as unknown as ReturnType<typeof vi.fn>)).toBeNull(); // but no PRO automations
      expect(storyCall(enqueue as unknown as ReturnType<typeof vi.fn>)).toBeNull();
      void channelId;
    } finally {
      spy.mockRestore();
      enqueue.mockRestore();
      await licenseInstance(); // restore PRO for any later tests
    }
  });

  it("redacts a token echoed in a provider error before persisting / emitting [PSA13]", async () => {
    if (!TEST_DB) return;
    const { postId } = await scenario();
    const editorialId = await linkEditorial(postId);
    const tt = (await import("@/lib/providers/tiktok")).tiktokProvider;
    const spy = vi.spyOn(tt, "publish").mockRejectedValue(
      new errs.PermanentError("Graph 400 for https://x?access_token=EAABLEAKEDTOKEN999 — bad request"),
    );
    try {
      await processPublish({ postId }, helpers);
      expect(await status(postId)).toBe("failed");
      const row = await db.query.deliveries.findFirst({ where: eq(schema.deliveries.id, postId) });
      expect(row!.last_error).not.toContain("EAABLEAKEDTOKEN999");
      expect(row!.last_error).toContain("[REDACTED]");
      const ev = (await db.query.events.findMany({ where: eq(schema.events.subject_id, editorialId) })).find((e) => e.type === "post.failed");
      expect(JSON.stringify(ev!.payload)).not.toContain("EAABLEAKEDTOKEN999");
    } finally {
      spy.mockRestore();
    }
  });
});

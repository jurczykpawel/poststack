import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type { JobHelpers } from "graphile-worker";
import { eq, sql } from "drizzle-orm";

// Drafting goes through the shared LLM client — stub it per-test so the worker is deterministic and
// makes no network call. vi.mock is hoisted; the factory returns a controllable mock.
const generateDraftMock = vi.fn<
  (args: { incomingText: string; isComment: boolean; target: "dm" | "public" | "both"; context?: string; prompt: string }) => Promise<string | null>
>();
vi.mock("@/lib/ai/draft", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/draft")>();
  return { ...actual, generateDraft: (args: Parameters<typeof actual.generateDraft>[0]) => generateDraftMock(args) };
});

// PRO gate is instance-global (one license verdict for all workspaces) and verifies against a remote
// JWKS — stub hasFeature so the worker is deterministic and makes no network call. Default: licensed
// (true); the free-instance test flips it to false. vi.mock is hoisted; this survives resetModules.
const hasFeatureMock = vi.fn<(feature: string) => Promise<boolean>>();
vi.mock("@/lib/license/gate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/license/gate")>();
  return { ...actual, hasFeature: (feature: string) => hasFeatureMock(feature) };
});

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let processAiDraft: typeof import("./ai-draft-worker").processAiDraft;
let seedWorkspace: typeof import("../../../tests/helpers/workspace").seedWorkspace;
let closeQueue: typeof import("@/lib/queue/client").closeQueue;

let WS = "";
let CH = "";
let CONTACT = "";
let CONV = "";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY = "test-encryption-key-at-least-32-characters-long";
  process.env.JWT_SECRET ??= "test-secret-at-least-32-characters-long";
  process.env.APP_URL ??= "http://localhost:3000";
  process.env.CRON_SECRET ??= "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  ({ processAiDraft } = await import("./ai-draft-worker"));
  ({ seedWorkspace } = await import("../../../tests/helpers/workspace"));
  ({ closeQueue } = await import("@/lib/queue/client"));
  WS = await seedWorkspace(db, s, { slug: `aidraft-${Date.now()}` });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.execute(sql.raw("truncate table graphile_worker._private_jobs cascade"));
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  if (closeQueue) await closeQueue();
  await db.$client.end();
});

// A fresh channel/contact/conversation per test so rows never collide across cases.
beforeEach(async () => {
  if (!TEST_DB) return;
  await db.execute(sql.raw("truncate table graphile_worker._private_jobs cascade"));
  await db.execute(sql`delete from rate_limit_counters where key like 'ai-draft:%'`);
  // The per-workspace daily cap uses a separate key prefix (`rl:llm-draft:<ws>`) — clean it too so a
  // capped run in one test never bleeds its counter into the next.
  await db.execute(sql`delete from rate_limit_counters where key like 'rl:llm-draft:%'`);
  await db.delete(s.outboundDeliveries).where(eq(s.outboundDeliveries.workspace_id, WS));
  await db.delete(s.pendingApprovals).where(eq(s.pendingApprovals.workspace_id, WS));
  await db.delete(s.conversations).where(eq(s.conversations.workspace_id, WS));
  await db.delete(s.contacts).where(eq(s.contacts.workspace_id, WS));
  await db.delete(s.channels).where(eq(s.channels.workspace_id, WS));
  generateDraftMock.mockReset();
  generateDraftMock.mockResolvedValue("Here is your reply");
  hasFeatureMock.mockReset();
  hasFeatureMock.mockResolvedValue(true); // licensed by default; the free-instance test overrides

  const [c] = await db
    .insert(s.channels)
    .values({ workspace_id: WS, platform: "facebook", platform_id: `PG-${Math.random()}`, token_encrypted: "x", webhook_secret: "s" })
    .returning({ id: s.channels.id });
  CH = c!.id;
  const [ct] = await db.insert(s.contacts).values({ workspace_id: WS }).returning({ id: s.contacts.id });
  CONTACT = ct!.id;
  const [cv] = await db
    .insert(s.conversations)
    .values({ workspace_id: WS, channel_id: CH, contact_id: CONTACT, platform: "facebook", status: "open" })
    .returning({ id: s.conversations.id });
  CONV = cv!.id;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function helpersFor(jobId = `j-${Math.random()}`): JobHelpers {
  return { job: { id: jobId }, logger: { info() {}, error() {} } } as unknown as JobHelpers;
}

async function setAutosend(over: { dm?: boolean; public?: boolean }) {
  await db
    .update(s.channels)
    .set({ ai_draft_autosend_dm: over.dm ?? false, ai_draft_autosend_public: over.public ?? false })
    .where(eq(s.channels.id, CH));
}

function baseJob(over: Partial<import("@/lib/queue/types").AiDraftJob> = {}): import("@/lib/queue/types").AiDraftJob {
  return {
    workspaceId: WS,
    channelId: CH,
    conversationId: CONV,
    contactId: CONTACT,
    recipientPlatformId: "PSID-A",
    incomingText: "hello",
    isComment: false,
    target: "dm",
    source: "ai_auto",
    ...over,
  };
}

async function pendingRows() {
  return db.query.pendingApprovals.findMany({ where: eq(s.pendingApprovals.workspace_id, WS) });
}
async function jobCount(task: string) {
  const r = await db.execute(sql`select count(*)::int as n from graphile_worker.jobs where task_identifier = ${task}`);
  return Number((r.rows[0] as { n: number }).n);
}
async function jobPayloads(task: string) {
  const r = await db.execute(
    sql`select pj.payload from graphile_worker.jobs j join graphile_worker._private_jobs pj on pj.id = j.id where j.task_identifier = ${task}`,
  );
  return (r.rows as { payload: Record<string, unknown> }[]).map((row) => row.payload);
}
async function deliveryCount() {
  return db.query.outboundDeliveries
    .findMany({ where: eq(s.outboundDeliveries.workspace_id, WS) })
    .then((rows) => rows.length);
}
async function setSubscribed(value: boolean) {
  await db.update(s.contacts).set({ is_subscribed: value }).where(eq(s.contacts.id, CONTACT));
}

describe("ai-draft worker (AIDRAFT1)", () => {
  it("auto + autosend off, target dm: parks ONE pending_approval(source=ai_auto) with the DM body", async () => {
    if (!TEST_DB) return;
    generateDraftMock.mockResolvedValue("Drafted DM");
    await processAiDraft(baseJob({ target: "dm" }), helpersFor());

    const rows = await pendingRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe("ai_auto");
    expect(rows[0]!.rule_id).toBeNull();
    const proposed = rows[0]!.proposed_content as { content?: { text?: string }; comment?: unknown };
    expect(proposed.content?.text).toBe("Drafted DM");
    expect(proposed.comment).toBeUndefined();
    expect(await jobCount("outgoing-message")).toBe(0);
  });

  it("target public: proposed_content.comment === {text, commentId}", async () => {
    if (!TEST_DB) return;
    generateDraftMock.mockResolvedValue("Public reply");
    await processAiDraft(baseJob({ target: "public", commentId: "CMT-1", isComment: true }), helpersFor());

    const rows = await pendingRows();
    expect(rows).toHaveLength(1);
    const proposed = rows[0]!.proposed_content as { content?: unknown; comment?: { text?: string; commentId?: string } };
    expect(proposed.comment).toEqual({ text: "Public reply", commentId: "CMT-1" });
    expect(proposed.content).toBeUndefined();
  });

  it("target both, autosend off: one row holds BOTH content + comment", async () => {
    if (!TEST_DB) return;
    generateDraftMock.mockResolvedValue("Both reply");
    await processAiDraft(baseJob({ target: "both", commentId: "CMT-2", isComment: true }), helpersFor());

    const rows = await pendingRows();
    expect(rows).toHaveLength(1);
    const proposed = rows[0]!.proposed_content as { content?: { text?: string }; comment?: { text?: string; commentId?: string } };
    expect(proposed.content?.text).toBe("Both reply");
    expect(proposed.comment).toEqual({ text: "Both reply", commentId: "CMT-2" });
  });

  it("generateDraft → null: inserts NOTHING (no empty approval, no send)", async () => {
    if (!TEST_DB) return;
    generateDraftMock.mockResolvedValue(null);
    await processAiDraft(baseJob({ target: "both", commentId: "CMT-3", isComment: true }), helpersFor());

    expect(await pendingRows()).toHaveLength(0);
    expect(await jobCount("outgoing-message")).toBe(0);
    expect(await jobCount("outgoing-comment")).toBe(0);
  });

  it("autosend_dm on + target dm: NO approval row; an outgoing-message send is enqueued", async () => {
    if (!TEST_DB) return;
    await setAutosend({ dm: true });
    generateDraftMock.mockResolvedValue("Autosent DM");
    await processAiDraft(baseJob({ target: "dm" }), helpersFor());

    expect(await pendingRows()).toHaveLength(0);
    expect(await jobCount("outgoing-message")).toBe(1);
    const [payload] = await jobPayloads("outgoing-message");
    expect((payload as { content: { text: string }; recipientPlatformId: string }).content.text).toBe("Autosent DM");
    expect((payload as { recipientPlatformId: string }).recipientPlatformId).toBe("PSID-A");
  });

  // Owner's concern: does an autosend reply (no human approval step) get generated with the SAME
  // context (post caption + conversation history) as a parked one? There is only ONE generateDraft
  // call in this worker (above the autosend/park dispatch), fed job.context verbatim — autosend vs.
  // park only decides where the ALREADY-GENERATED text goes. Prove the context reaches the LLM call
  // unchanged even when the channel is configured to autosend.
  it("passes job.context to generateDraft unchanged for an autosend-configured channel — context building doesn't differ by outcome", async () => {
    if (!TEST_DB) return;
    await setAutosend({ dm: true });
    generateDraftMock.mockResolvedValue("Autosent with context");
    await processAiDraft(baseJob({ target: "dm", context: "Post: we shipped a new feature\n\nRecent conversation:\nCustomer: hi\nYou: hello" }), helpersFor());

    expect(generateDraftMock).toHaveBeenCalledTimes(1);
    expect(generateDraftMock.mock.calls[0][0].context).toBe("Post: we shipped a new feature\n\nRecent conversation:\nCustomer: hi\nYou: hello");
  });

  it("target both, autosend_dm on / autosend_public off: DM sends (private reply), public part parked", async () => {
    if (!TEST_DB) return;
    await setAutosend({ dm: true, public: false });
    generateDraftMock.mockResolvedValue("Mixed reply");
    await processAiDraft(baseJob({ target: "both", commentId: "CMT-4", isComment: true }), helpersFor());

    // DM (comment-triggered) goes out as a first-touch private reply.
    expect(await jobCount("outgoing-private-reply")).toBe(1);
    const [dm] = await jobPayloads("outgoing-private-reply");
    expect((dm as { commentId: string; text: string }).commentId).toBe("CMT-4");
    expect((dm as { text: string }).text).toBe("Mixed reply");
    expect(await jobCount("outgoing-comment")).toBe(0);

    // Public part is parked for approval (comment only — no content).
    const rows = await pendingRows();
    expect(rows).toHaveLength(1);
    const proposed = rows[0]!.proposed_content as { content?: unknown; comment?: { commentId?: string } };
    expect(proposed.content).toBeUndefined();
    expect(proposed.comment).toEqual({ text: "Mixed reply", commentId: "CMT-4" });
  });

  it("daily cap: AI_DRAFT_DAILY_LIMIT=1 → a 2nd generation in-window creates no row", async () => {
    if (!TEST_DB) return;
    const prev = process.env.AI_DRAFT_DAILY_LIMIT;
    process.env.AI_DRAFT_DAILY_LIMIT = "1";
    vi.resetModules();
    // Spy on the SAME fresh rate-limit instance the reset worker imports (both share the registry
    // after resetModules), so we can assert the cap is consulted with the right key/limit/window.
    const rl = await import("@/lib/api/rate-limit");
    const spy = vi.spyOn(rl, "rateLimit");
    const { processAiDraft: capped } = await import("./ai-draft-worker");
    try {
      generateDraftMock.mockResolvedValue("Capped reply");
      await capped(baseJob({ target: "dm" }), helpersFor());
      await capped(baseJob({ target: "dm" }), helpersFor());
      // Only the first drafting ran (second hit the cap before generating).
      expect(generateDraftMock).toHaveBeenCalledTimes(1);
      expect(await pendingRows()).toHaveLength(1);
      // The cap is keyed per-workspace with the configured limit (1) over a rolling 24h window.
      expect(spy).toHaveBeenCalledWith(`rl:llm-draft:${WS}`, 1, 86_400);
    } finally {
      if (prev === undefined) delete process.env.AI_DRAFT_DAILY_LIMIT;
      else process.env.AI_DRAFT_DAILY_LIMIT = prev;
      vi.resetModules();
    }
  });

  it("daily cap: AI_DRAFT_DAILY_LIMIT=0 (default) → rateLimit NOT consulted; generation always proceeds", async () => {
    if (!TEST_DB) return;
    // env default is 0 (unlimited). Spy on the shared rate-limit util to prove the cap path is never
    // taken, and run two distinct jobs to show generation isn't throttled (both park a row).
    const rl = await import("@/lib/api/rate-limit");
    const spy = vi.spyOn(rl, "rateLimit");
    generateDraftMock.mockResolvedValue("Unlimited reply");
    await processAiDraft(baseJob({ target: "dm" }), helpersFor("u-1"));
    await processAiDraft(baseJob({ target: "dm" }), helpersFor("u-2"));
    expect(spy).not.toHaveBeenCalled();
    expect(generateDraftMock).toHaveBeenCalledTimes(2);
    expect(await pendingRows()).toHaveLength(2);
  });

  // PRO gate (worker-side). The no-match AUTO path enqueues an ai-draft job regardless of license;
  // the worker must check hasFeature("ai_draft") BEFORE paying for the LLM, so a free instance never
  // generates (no draft, no approval row, no charge). The on-demand button + config routes gate too.
  it("feature gate: a free instance (no ai_draft) → no generation, no draft, no send", async () => {
    if (!TEST_DB) return;
    hasFeatureMock.mockResolvedValue(false);
    generateDraftMock.mockResolvedValue("Should never run");
    await processAiDraft(baseJob({ target: "dm" }), helpersFor());

    expect(generateDraftMock).not.toHaveBeenCalled();
    expect(await pendingRows()).toHaveLength(0);
    expect(await jobCount("outgoing-message")).toBe(0);
  });

  it("feature gate: a licensed instance (ai_draft) → generation proceeds", async () => {
    if (!TEST_DB) return;
    hasFeatureMock.mockResolvedValue(true);
    generateDraftMock.mockResolvedValue("Licensed draft");
    await processAiDraft(baseJob({ target: "dm" }), helpersFor());

    expect(generateDraftMock).toHaveBeenCalledTimes(1);
    expect(await pendingRows()).toHaveLength(1);
  });

  it("idempotency: a redelivery of the same job does not double-park or double-generate", async () => {
    if (!TEST_DB) return;
    generateDraftMock.mockResolvedValue("Once only");
    const h = helpersFor("stable-job-1");
    await processAiDraft(baseJob({ target: "dm" }), h);
    await processAiDraft(baseJob({ target: "dm" }), h);
    expect(await pendingRows()).toHaveLength(1);
    expect(generateDraftMock).toHaveBeenCalledTimes(1);
  });

  // Fix 1 — consent gate on autosend. The comment→DM autosend goes out via the private-reply
  // surface, which has NO consent gate of its own; an autosend to an unsubscribed contact would
  // still DM them. The worker must re-check is_subscribed and PARK instead of sending.
  it("consent: autosend dm + commentId (private-reply) to an UNSUBSCRIBED contact → no send, parked", async () => {
    if (!TEST_DB) return;
    await setAutosend({ dm: true });
    await setSubscribed(false);
    generateDraftMock.mockResolvedValue("Blocked DM");
    await processAiDraft(baseJob({ target: "dm", commentId: "CMT-NS", isComment: true }), helpersFor());

    // Nothing goes out on any surface.
    expect(await jobCount("outgoing-private-reply")).toBe(0);
    expect(await jobCount("outgoing-message")).toBe(0);
    // The part is parked so a human can still see/act on it (never silently dropped).
    const rows = await pendingRows();
    expect(rows).toHaveLength(1);
    const proposed = rows[0]!.proposed_content as { content?: { text?: string } };
    expect(proposed.content?.text).toBe("Blocked DM");
  });

  it("consent: autosend dm + commentId (private-reply) to a SUBSCRIBED contact → sends as before", async () => {
    if (!TEST_DB) return;
    await setAutosend({ dm: true });
    await setSubscribed(true);
    generateDraftMock.mockResolvedValue("Allowed DM");
    await processAiDraft(baseJob({ target: "dm", commentId: "CMT-S", isComment: true }), helpersFor());

    expect(await jobCount("outgoing-private-reply")).toBe(1);
    expect(await pendingRows()).toHaveLength(0);
  });

  // The consent gate is unified in code (one caller-side check covering every autosend surface).
  // These two cases prove it also blocks the OTHER surfaces, not just the comment→DM private-reply.

  // Plain-DM surface (target dm, no commentId → outgoing-message): an unsubscribed contact must be
  // parked, never autosent.
  it("consent: autosend dm, NO commentId (plain DM → outgoing-message) to an UNSUBSCRIBED contact → no send, parked", async () => {
    if (!TEST_DB) return;
    await setAutosend({ dm: true });
    await setSubscribed(false);
    generateDraftMock.mockResolvedValue("Blocked plain DM");
    await processAiDraft(baseJob({ target: "dm" }), helpersFor());

    expect(await jobCount("outgoing-message")).toBe(0);
    expect(await jobCount("outgoing-private-reply")).toBe(0);
    const rows = await pendingRows();
    expect(rows).toHaveLength(1);
    const proposed = rows[0]!.proposed_content as { content?: { text?: string } };
    expect(proposed.content?.text).toBe("Blocked plain DM");
  });

  // Public-comment surface (target public → outgoing-comment): an unsubscribed contact must be
  // parked, never autosent.
  it("consent: autosend public (public comment → outgoing-comment) to an UNSUBSCRIBED contact → no send, parked", async () => {
    if (!TEST_DB) return;
    await setAutosend({ public: true });
    await setSubscribed(false);
    generateDraftMock.mockResolvedValue("Blocked public comment");
    await processAiDraft(baseJob({ target: "public", commentId: "CMT-PUB-NS", isComment: true }), helpersFor());

    expect(await jobCount("outgoing-comment")).toBe(0);
    const rows = await pendingRows();
    expect(rows).toHaveLength(1);
    const proposed = rows[0]!.proposed_content as { comment?: { text?: string; commentId?: string } };
    expect(proposed.comment).toEqual({ text: "Blocked public comment", commentId: "CMT-PUB-NS" });
  });

  // Fix 2 — no phantom "sent" outbound_deliveries marker. stats/overview + telemetry count
  // outbound_deliveries rows, so a per-draft decision marker double-counted (approval-only drafts
  // looked "sent"; autosends counted marker + the real delivery). The worker must write NONE.
  it("no phantom delivery: an approval-only draft writes ZERO outbound_deliveries rows", async () => {
    if (!TEST_DB) return;
    generateDraftMock.mockResolvedValue("Parked, not sent");
    await processAiDraft(baseJob({ target: "dm" }), helpersFor());

    expect(await pendingRows()).toHaveLength(1);
    expect(await deliveryCount()).toBe(0);
  });

  it("no phantom delivery: an autosend writes ZERO ai-draft delivery rows (only the real send row, later)", async () => {
    if (!TEST_DB) return;
    await setAutosend({ dm: true });
    generateDraftMock.mockResolvedValue("Real send");
    await processAiDraft(baseJob({ target: "dm" }), helpersFor());

    // Exactly one real outgoing-message job is enqueued; the actual 'sent' row is written by the
    // delivery worker when that job runs — so the autosend can never double-count (marker + real).
    expect(await jobCount("outgoing-message")).toBe(1);
    expect(await deliveryCount()).toBe(0);
  });

  // On-demand path: `ai_manual` is an explicit human "Generate reply" request and is ALWAYS parked
  // for approval — even when the channel's autosend flags are on (which would autosend `ai_auto`).
  it("manual always parks: source=ai_manual with autosend_dm ON → no send, ONE approval row", async () => {
    if (!TEST_DB) return;
    await setAutosend({ dm: true, public: true });
    await setSubscribed(true);
    generateDraftMock.mockResolvedValue("Manual draft");
    await processAiDraft(baseJob({ target: "dm", source: "ai_manual" }), helpersFor());

    // Nothing autosent on any surface.
    expect(await jobCount("outgoing-message")).toBe(0);
    expect(await jobCount("outgoing-private-reply")).toBe(0);
    // The draft is parked for approval, labelled ai_manual.
    const rows = await pendingRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe("ai_manual");
    const proposed = rows[0]!.proposed_content as { content?: { text?: string } };
    expect(proposed.content?.text).toBe("Manual draft");
  });

  it("idempotency without phantom marker: redelivery doesn't double-insert the approval", async () => {
    if (!TEST_DB) return;
    generateDraftMock.mockResolvedValue("Idem");
    const h = helpersFor("stable-job-2");
    await processAiDraft(baseJob({ target: "dm" }), h);
    await processAiDraft(baseJob({ target: "dm" }), h);
    expect(await pendingRows()).toHaveLength(1);
    expect(generateDraftMock).toHaveBeenCalledTimes(1);
    expect(await deliveryCount()).toBe(0);
  });
});

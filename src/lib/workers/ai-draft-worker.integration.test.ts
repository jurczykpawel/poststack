import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type { JobHelpers } from "graphile-worker";
import { eq, sql } from "drizzle-orm";

// Drafting goes through the shared LLM client — stub it per-test so the worker is deterministic and
// makes no network call. vi.mock is hoisted; the factory returns a controllable mock.
const generateDraftMock = vi.fn<(args: { incomingText: string; context?: string; prompt: string }) => Promise<string | null>>();
vi.mock("@/lib/ai/draft", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/draft")>();
  return { ...actual, generateDraft: (args: Parameters<typeof actual.generateDraft>[0]) => generateDraftMock(args) };
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
  await db.delete(s.outboundDeliveries).where(eq(s.outboundDeliveries.workspace_id, WS));
  await db.delete(s.pendingApprovals).where(eq(s.pendingApprovals.workspace_id, WS));
  await db.delete(s.conversations).where(eq(s.conversations.workspace_id, WS));
  await db.delete(s.contacts).where(eq(s.contacts.workspace_id, WS));
  await db.delete(s.channels).where(eq(s.channels.workspace_id, WS));
  generateDraftMock.mockReset();
  generateDraftMock.mockResolvedValue("Here is your reply");

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
    await processAiDraft(baseJob({ target: "public", commentId: "CMT-1" }), helpersFor());

    const rows = await pendingRows();
    expect(rows).toHaveLength(1);
    const proposed = rows[0]!.proposed_content as { content?: unknown; comment?: { text?: string; commentId?: string } };
    expect(proposed.comment).toEqual({ text: "Public reply", commentId: "CMT-1" });
    expect(proposed.content).toBeUndefined();
  });

  it("target both, autosend off: one row holds BOTH content + comment", async () => {
    if (!TEST_DB) return;
    generateDraftMock.mockResolvedValue("Both reply");
    await processAiDraft(baseJob({ target: "both", commentId: "CMT-2" }), helpersFor());

    const rows = await pendingRows();
    expect(rows).toHaveLength(1);
    const proposed = rows[0]!.proposed_content as { content?: { text?: string }; comment?: { text?: string; commentId?: string } };
    expect(proposed.content?.text).toBe("Both reply");
    expect(proposed.comment).toEqual({ text: "Both reply", commentId: "CMT-2" });
  });

  it("generateDraft → null: inserts NOTHING (no empty approval, no send)", async () => {
    if (!TEST_DB) return;
    generateDraftMock.mockResolvedValue(null);
    await processAiDraft(baseJob({ target: "both", commentId: "CMT-3" }), helpersFor());

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

  it("target both, autosend_dm on / autosend_public off: DM sends (private reply), public part parked", async () => {
    if (!TEST_DB) return;
    await setAutosend({ dm: true, public: false });
    generateDraftMock.mockResolvedValue("Mixed reply");
    await processAiDraft(baseJob({ target: "both", commentId: "CMT-4" }), helpersFor());

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
    const { processAiDraft: capped } = await import("./ai-draft-worker");
    try {
      generateDraftMock.mockResolvedValue("Capped reply");
      await capped(baseJob({ target: "dm" }), helpersFor());
      await capped(baseJob({ target: "dm" }), helpersFor());
      // Only the first drafting ran (second hit the cap before generating).
      expect(generateDraftMock).toHaveBeenCalledTimes(1);
      expect(await pendingRows()).toHaveLength(1);
    } finally {
      if (prev === undefined) delete process.env.AI_DRAFT_DAILY_LIMIT;
      else process.env.AI_DRAFT_DAILY_LIMIT = prev;
      vi.resetModules();
    }
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
});

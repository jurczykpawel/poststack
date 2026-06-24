import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { NormalizedEmail } from "@/lib/platforms/email";

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let poll: typeof import("./poll");
let encryptTokens: typeof import("@/lib/crypto").encryptTokens;
let closeQueue: typeof import("@/lib/queue/client").closeQueue;
let GmailProvider: typeof import("@/lib/platforms/gmail").GmailProvider;

const WS = "22220000-0000-0000-0000-0000000000b1";
const CH = "22220000-0000-0000-0000-0000000000b2";
const INBOX = "support@firma.pl";

function email(id: string, from: string, internalDate: number, subject = `Re ${id}`): NormalizedEmail {
  return {
    messageId: `<rfc-${id}@mail>`,
    threadId: `thread-${id}`,
    fromEmail: from,
    fromName: undefined,
    subject,
    text: `body ${id}`,
    internalDate,
  };
}

async function pendingJobs() {
  const rows = await db.execute(
    sql`select t.identifier as task_identifier, j.payload
        from graphile_worker._private_jobs j
        join graphile_worker._private_tasks t on t.id = j.task_id
        order by j.created_at`,
  );
  return (rows as unknown as { rows: { task_identifier: string; payload: unknown }[] }).rows;
}

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  process.env.GOOGLE_CLIENT_ID = "gid";
  process.env.GOOGLE_CLIENT_SECRET = "gsec";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  poll = await import("./poll");
  ({ encryptTokens } = await import("@/lib/crypto"));
  ({ closeQueue } = await import("@/lib/queue/client"));
  ({ GmailProvider } = await import("@/lib/platforms/gmail"));
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.execute(sql`truncate table graphile_worker._private_jobs cascade`);
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.insert(s.workspaces).values({ id: WS, name: "GM", slug: `gm-${WS}` });
  await db.insert(s.channels).values({
    id: CH, workspace_id: WS, platform: "gmail", platform_id: INBOX, display_name: "Support",
    token_encrypted: encryptTokens({ access_token: "at", refresh_token: "rt", expires_at: Math.floor(Date.now() / 1000) + 3600 }),
    webhook_secret: "s", status: "active", gmail_query: "in:inbox",
    gmail_sync_cursor: "1700000000000", // already past first connect → normal poll path
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.execute(sql`truncate table graphile_worker._private_jobs cascade`);
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  if (closeQueue) await closeQueue();
});

describe("pollEmailChannel (real Postgres)", () => {
  it("enqueues one incoming-message per new mail with email threading + canonicalized sender, advances cursor", async () => {
    if (!TEST_DB) return;
    const m1 = email("a", "J.a.N+promo@googlemail.com", 1700000001000, "Zażółć gęślą");
    const m2 = email("b", "Anna@FIRMA.PL", 1700000002000);
    vi.spyOn(GmailProvider.prototype, "listNewMessages").mockResolvedValue(["a", "b"]);
    vi.spyOn(GmailProvider.prototype, "fetchMessage").mockImplementation(async (_ch, id) => (id === "a" ? m1 : m2));

    const r = await poll.pollEmailChannel(CH);
    expect(r.ingested).toBe(2);
    expect(r.cursor).toBe("1700000002000");

    const jobs = await pendingJobs();
    expect(jobs.filter((j) => j.task_identifier === "incoming-message")).toHaveLength(2);
    const payloads = jobs.map((j) => j.payload as Record<string, unknown>);
    const pa = payloads.find((p) => p.mid === "<rfc-a@mail>")!;
    expect(pa.platform).toBe("gmail");
    expect(pa.channelId).toBe(CH);
    expect(pa.pageId).toBe(INBOX);
    expect(pa.recipientId).toBe(INBOX);
    expect(pa.senderId).toBe("jan@gmail.com"); // canonicalized
    expect(pa.threadType).toBe("email");
    expect(pa.threadId).toBe("thread-a");
    expect(pa.subject).toBe("Zażółć gęślą");
    expect(pa.text).toBe("body a");
    expect(pa.timestamp).toBe(1700000001000);
    const pb = payloads.find((p) => p.mid === "<rfc-b@mail>")!;
    expect(pb.senderId).toBe("anna@firma.pl");

    const ch = await db.query.channels.findFirst({ where: eq(s.channels.id, CH), columns: { gmail_sync_cursor: true } });
    expect(ch!.gmail_sync_cursor).toBe("1700000002000");
  });

  it("re-poll with the advanced cursor yields zero new (cursor passed to provider)", async () => {
    if (!TEST_DB) return;
    vi.spyOn(GmailProvider.prototype, "fetchMessage").mockResolvedValue(email("a", "a@x.pl", 1700000001000));
    const list = vi.spyOn(GmailProvider.prototype, "listNewMessages").mockResolvedValueOnce(["a"]).mockResolvedValueOnce([]);

    const r1 = await poll.pollEmailChannel(CH);
    expect(r1.ingested).toBe(1);
    const r2 = await poll.pollEmailChannel(CH);
    expect(r2.ingested).toBe(0);
    // second call received the advanced cursor, not null.
    expect(list.mock.calls[1][1]).toBe("1700000001000");
  });

  it("first poll after connect (null cursor) establishes a forward-only baseline, ingests nothing historical", async () => {
    if (!TEST_DB) return;
    await db.update(s.channels).set({ gmail_sync_cursor: null }).where(eq(s.channels.id, CH));
    const list = vi.spyOn(GmailProvider.prototype, "listNewMessages").mockResolvedValue(["a", "b"]);
    const before = Date.now();

    const r = await poll.pollEmailChannel(CH);

    expect(r.ingested).toBe(0); // no inbox backfill
    expect(list).not.toHaveBeenCalled(); // never even listed historical mail
    expect((await pendingJobs()).filter((j) => j.task_identifier === "incoming-message")).toHaveLength(0);
    const ch = await db.query.channels.findFirst({ where: eq(s.channels.id, CH), columns: { gmail_sync_cursor: true } });
    expect(Number(ch!.gmail_sync_cursor)).toBeGreaterThanOrEqual(before); // baseline = now
  });

  it("skips the mailbox's own sent messages (no self-echo / auto-reply loop) but advances the cursor", async () => {
    if (!TEST_DB) return;
    // A broad filter matches the Sent copy of our own reply (from = the channel's own address).
    const own = email("own", INBOX, 1700000003000, "Re: hi");
    const fromClient = email("c", "client@x.pl", 1700000004000, "hi");
    vi.spyOn(GmailProvider.prototype, "listNewMessages").mockResolvedValue(["own", "c"]);
    vi.spyOn(GmailProvider.prototype, "fetchMessage").mockImplementation(async (_ch, id) => (id === "own" ? own : fromClient));

    const r = await poll.pollEmailChannel(CH);

    expect(r.ingested).toBe(1); // only the client mail, not our own send
    const jobs = (await pendingJobs()).filter((j) => j.task_identifier === "incoming-message");
    expect(jobs).toHaveLength(1);
    expect((jobs[0].payload as Record<string, unknown>).senderId).toBe("client@x.pl");
    expect(r.cursor).toBe("1700000004000"); // cursor still advances past the skipped self-send
  });
});

describe("sweepEmailChannels", () => {
  it("polls every active gmail channel", async () => {
    if (!TEST_DB) return;
    vi.spyOn(GmailProvider.prototype, "listNewMessages").mockResolvedValue(["a"]);
    vi.spyOn(GmailProvider.prototype, "fetchMessage").mockResolvedValue(email("a", "a@x.pl", 1700000001000));
    const r = await poll.sweepEmailChannels();
    expect(r.channels).toBe(1);
    expect(r.ingested).toBe(1);
  });
});

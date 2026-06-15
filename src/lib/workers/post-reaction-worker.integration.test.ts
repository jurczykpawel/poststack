import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { JobHelpers } from "graphile-worker";

const TEST_DB = process.env.TEST_DATABASE_URL;

let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let processIncomingPostReaction: typeof import("./incoming-post-reaction-worker").processIncomingPostReaction;

const WS = "0c0a0000-0000-0000-0000-0000000000d1";
const CH = "0c0a0000-0000-0000-0000-0000000000d2";
const PAGE = "PG-POSTREACT";

const helpers = { logger: { info() {} } } as unknown as JobHelpers;

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  ({ processIncomingPostReaction } = await import("./incoming-post-reaction-worker"));
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.insert(s.workspaces).values({ id: WS, name: "PR", slug: `pr-${WS}` });
  await db.insert(s.channels).values({ id: CH, workspace_id: WS, platform: "facebook", platform_id: PAGE, token_encrypted: "x", webhook_secret: "s", status: "active" });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.$client.end();
});

const job = (over: Partial<Parameters<typeof processIncomingPostReaction>[0]> = {}) => ({
  platform: "facebook", pageId: PAGE, postId: "POST-1", reactorId: "U1", reactorName: "Ann",
  reactionType: "love", verb: "add" as const, ...over,
});

const rows = () => db.select().from(s.postReactions).where(eq(s.postReactions.channel_id, CH));

describe("processIncomingPostReaction", () => {
  it("records a post reaction with reactor + type", async () => {
    if (!TEST_DB) return;
    await processIncomingPostReaction(job(), helpers);
    const r = await rows();
    expect(r.length).toBe(1);
    expect(r[0].post_id).toBe("POST-1");
    expect(r[0].reactor_id).toBe("U1");
    expect(r[0].reactor_name).toBe("Ann");
    expect(r[0].reaction_type).toBe("love");
  });

  it("upserts a changed reaction in place (no duplicate)", async () => {
    if (!TEST_DB) return;
    await processIncomingPostReaction(job(), helpers);
    await processIncomingPostReaction(job({ reactionType: "wow" }), helpers);
    const r = await rows();
    expect(r.length).toBe(1);
    expect(r[0].reaction_type).toBe("wow");
  });

  it("deletes the row on an unreact (verb=remove)", async () => {
    if (!TEST_DB) return;
    await processIncomingPostReaction(job(), helpers);
    await processIncomingPostReaction(job({ verb: "remove" }), helpers);
    expect((await rows()).length).toBe(0);
  });

  it("skips a reaction for an unknown page (no channel)", async () => {
    if (!TEST_DB) return;
    await processIncomingPostReaction(job({ pageId: "NOPE" }), helpers);
    expect((await rows()).length).toBe(0);
  });

  it("marks the webhook event 'recorded' (engagement only) — never 'fired'", async () => {
    if (!TEST_DB) return;
    const key = `evt-pr-${WS}`;
    await db.delete(s.webhookEvents).where(eq(s.webhookEvents.event_key, key));
    await db.insert(s.webhookEvents).values({ event_key: key, channel_id: CH, event_type: "post_reaction", field: "feed", raw: {}, handling_status: "received" });
    await processIncomingPostReaction(job({ eventKey: key }), helpers);
    const ev = await db.query.webhookEvents.findFirst({ where: eq(s.webhookEvents.event_key, key) });
    expect(ev?.handling_status).toBe("recorded");
  });
});

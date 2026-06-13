import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { createHash } from "crypto";
import { eq } from "drizzle-orm";
import { licenseInstance } from "@/lib/license/__fixtures__/license-instance";

// Mock the queue client so we can drive an enqueue failure; the DB is real.
const addJobTx = vi.fn(async (..._args: unknown[]): Promise<void> => {});
vi.mock("@/lib/queue/client", () => ({
  addJobTx: (...a: unknown[]) => addJobTx(...a),
  closeQueue: async () => {},
}));

const TEST_DB = process.env.TEST_DATABASE_URL;
const RAW_KEY = "rs_live_aud21_manual_reply_key_0123456";

let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let POST: typeof import("./route").POST;
let GET: typeof import("./route").GET;

const WS = "cccccccc-0000-0000-0000-0000000000e1";
const CH = "cccccccc-0000-0000-0000-0000000000e2";
const CONTACT = "cccccccc-0000-0000-0000-0000000000e3";
const CONV = "cccccccc-0000-0000-0000-0000000000e4";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.TOKEN_ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  ({ POST, GET } = await import("./route"));
  // Conversation messages (read + manual reply) are the PRO contacts-CRM surface.
  await licenseInstance();
});

beforeEach(async () => {
  if (!TEST_DB) return;
  vi.clearAllMocks();
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.insert(s.workspaces).values({ id: WS, name: "M", slug: `m-${WS}` });
  await db.insert(s.channels).values({ id: CH, workspace_id: WS, platform: "facebook", platform_id: "PG-M", token_encrypted: "x", webhook_secret: "s" });
  await db.insert(s.contacts).values({ id: CONTACT, workspace_id: WS });
  await db.insert(s.contactChannels).values({ contact_id: CONTACT, channel_id: CH, platform_sender_id: "PSID-M" });
  await db.insert(s.conversations).values({ id: CONV, workspace_id: WS, channel_id: CH, contact_id: CONTACT, platform: "facebook", needs_manual_reply: true });
  await db.insert(s.apiKeys).values({ workspace_id: WS, name: "k", key_hash: createHash("sha256").update(RAW_KEY).digest("hex"), key_prefix: "rs_live_aud21" });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.delete(s.instanceLicense);
});

const ctx = { params: Promise.resolve({ conversationId: CONV }) };
function postReq() {
  return new Request(`http://x/api/v1/conversations/${CONV}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${RAW_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ text: "thanks!" }),
  });
}
async function flag() {
  const [c] = await db.select().from(s.conversations).where(eq(s.conversations.id, CONV));
  return c.needs_manual_reply;
}

describe("manual reply — clear-flag + enqueue is atomic", () => {
  it("keeps needs_manual_reply set when the enqueue fails (nothing went out)", async () => {
    if (!TEST_DB) return;
    addJobTx.mockRejectedValueOnce(new Error("queue down"));
    await expect(POST(postReq(), ctx)).rejects.toThrow();
    expect(await flag()).toBe(true);
  });

  it("clears the flag and queues the reply when the enqueue succeeds", async () => {
    if (!TEST_DB) return;
    const res = await POST(postReq(), ctx);
    expect(res.status).toBe(201);
    expect(addJobTx).toHaveBeenCalledTimes(1);
    expect(await flag()).toBe(false);
  });

  // an over-long Idempotency-Key would overflow graphile's 512-char job_key cap and
  // surface as a 500; bound it to a clean 400.
  it("rejects an over-long Idempotency-Key with 400 (not 500)", async () => {
    if (!TEST_DB) return;
    const req = new Request(`http://x/api/v1/conversations/${CONV}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${RAW_KEY}`, "content-type": "application/json", "Idempotency-Key": "k".repeat(1000) },
      body: JSON.stringify({ text: "thanks!" }),
    });
    const res = await POST(req, ctx);
    expect(res.status).toBe(400);
    expect(addJobTx).not.toHaveBeenCalled();
  });

  // clearing the flag must advance last_message_at NOW (the resolution marker), so a
  // stale old-inbound final-retry can't re-raise the flag before the outgoing job runs.
  it("advances last_message_at on manual reply so a later stale retry cannot re-raise the flag", async () => {
    if (!TEST_DB) return;
    const past = new Date("2020-01-01T00:00:00.000Z");
    await db.update(s.conversations).set({ last_message_at: past }).where(eq(s.conversations.id, CONV));
    const res = await POST(postReq(), ctx);
    expect(res.status).toBe(201);
    const [c] = await db.select().from(s.conversations).where(eq(s.conversations.id, CONV));
    expect(c.needs_manual_reply).toBe(false);
    expect(c.last_message_at!.getTime()).toBeGreaterThan(past.getTime());
  });
});

// a non-ISO cursor is a client error (400), not an Invalid Date that throws when the query
// param is serialized (which surfaced as a 500).
describe("messages GET — cursor validation", () => {
  const getReq = (qs: string) =>
    new Request(`http://x/api/v1/conversations/${CONV}/messages${qs}`, { headers: { authorization: `Bearer ${RAW_KEY}` } });

  it("returns a validation error for a non-ISO cursor (not a 500)", async () => {
    if (!TEST_DB) return;
    const res = await GET(getReq("?cursor=garbage"), ctx);
    expect(res.status).toBe(422); // ApiErrors.validationError — a clean client error, not Invalid-Date 500
  });

  it("accepts a valid ISO cursor", async () => {
    if (!TEST_DB) return;
    const res = await GET(getReq(`?cursor=${encodeURIComponent(new Date().toISOString())}`), ctx);
    expect(res.status).toBe(200);
  });
});

// Manual (human) reply is a PRO feature (manual_reply): free relies on rule auto-replies and handles
// a needs-reply in the native app. Runs LAST + re-seeds PRO so it doesn't starve other suites.
describe("manual reply — PRO gate (manual_reply)", () => {
  it("blocks sending a manual reply without a PRO license (402)", async () => {
    if (!TEST_DB) return;
    const { invalidateLicenseCache } = await import("@/lib/license/gate");
    await db.delete(s.instanceLicense);
    invalidateLicenseCache();
    try {
      const res = await POST(postReq(), ctx);
      expect(res.status).toBe(402);
      expect((await res.json()).error.code).toBe("PRO_REQUIRED");
      expect(addJobTx).not.toHaveBeenCalled(); // nothing was sent
    } finally {
      await licenseInstance(); // restore PRO for any later work
      invalidateLicenseCache();
    }
  });
});

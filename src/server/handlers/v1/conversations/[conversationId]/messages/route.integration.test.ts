import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { createHash } from "crypto";
import { eq } from "drizzle-orm";

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
  ({ POST } = await import("./route"));
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
});

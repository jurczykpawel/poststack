import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createHash } from "crypto";
import { and, eq } from "drizzle-orm";

vi.mock("@/lib/queue/client", () => ({
  addJob: vi.fn(async () => {}),
  closeQueue: async () => {},
}));

import { vi } from "vitest";

const TEST_DB = process.env.TEST_DATABASE_URL;
const RAW_KEY_A = "sk_live_gmail_filter_key_abcdef01";
const RAW_KEY_B = "sk_live_gmail_filter_key_abcdef02";

let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let POST: typeof import("./route").POST;

const WS_A = "eeeeeeee-0000-0000-0000-0000000000e1";
const WS_B = "eeeeeeee-0000-0000-0000-0000000000e2";
const CH_A = "eeeeeeee-0000-0000-0000-0000000000e3";
const CH_B = "eeeeeeee-0000-0000-0000-0000000000e4";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  ({ POST } = await import("./route"));
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.delete(s.channels).where(eq(s.channels.workspace_id, WS_A));
  await db.delete(s.channels).where(eq(s.channels.workspace_id, WS_B));
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS_A));
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS_B));
  await db.insert(s.workspaces).values([
    { id: WS_A, name: "WS-A", slug: `gf-ws-a-${WS_A}` },
    { id: WS_B, name: "WS-B", slug: `gf-ws-b-${WS_B}` },
  ]);
  await db.insert(s.apiKeys).values([
    {
      workspace_id: WS_A, name: "key-a",
      key_hash: createHash("sha256").update(RAW_KEY_A).digest("hex"),
      key_prefix: "sk_live_gf_a",
    },
    {
      workspace_id: WS_B, name: "key-b",
      key_hash: createHash("sha256").update(RAW_KEY_B).digest("hex"),
      key_prefix: "sk_live_gf_b",
    },
  ]);
  await db.insert(s.channels).values([
    {
      id: CH_A, workspace_id: WS_A, platform: "gmail", platform_id: "gm-a@test.com",
      token_encrypted: "x", webhook_secret: "s", status: "active", connection_mode: "oauth",
    },
    {
      id: CH_B, workspace_id: WS_B, platform: "gmail", platform_id: "gm-b@test.com",
      token_encrypted: "x", webhook_secret: "s", status: "active", connection_mode: "oauth",
    },
  ]);
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.channels).where(eq(s.channels.workspace_id, WS_A));
  await db.delete(s.channels).where(eq(s.channels.workspace_id, WS_B));
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS_A));
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS_B));
  await db.$client.end?.();
});

function postReq(channelId: string, key: string, body: unknown) {
  return new Request(`http://x/api/v1/channels/${channelId}/gmail-filter`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("POST /api/v1/channels/:id/gmail-filter", () => {
  it("saves gmail_query for an in-workspace Gmail channel", async () => {
    if (!TEST_DB) return;
    const res = await POST(postReq(CH_A, RAW_KEY_A, { query: "label:Support from:vip@x" }), ctx(CH_A));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.gmail_query).toBe("label:Support from:vip@x");

    const row = await db.query.channels.findFirst({
      where: and(eq(s.channels.id, CH_A), eq(s.channels.workspace_id, WS_A)),
      columns: { gmail_query: true },
    });
    expect(row?.gmail_query).toBe("label:Support from:vip@x");
  });

  it("returns 404 when the channel belongs to a different workspace", async () => {
    if (!TEST_DB) return;
    // WS_B's key tries to update WS_A's channel
    const res = await POST(postReq(CH_A, RAW_KEY_B, { query: "label:inbox" }), ctx(CH_A));
    expect([403, 404]).toContain(res.status);
  });

  it("returns 422 when query exceeds 1000 characters", async () => {
    if (!TEST_DB) return;
    const res = await POST(postReq(CH_A, RAW_KEY_A, { query: "x".repeat(1001) }), ctx(CH_A));
    expect(res.status).toBe(422);
  });

  it("returns 422 when query is not a string", async () => {
    if (!TEST_DB) return;
    const res = await POST(postReq(CH_A, RAW_KEY_A, { query: 42 }), ctx(CH_A));
    expect(res.status).toBe(422);
  });

  it("returns 401 for unauthenticated requests", async () => {
    if (!TEST_DB) return;
    const res = await POST(
      new Request(`http://x/api/v1/channels/${CH_A}/gmail-filter`, { method: "POST", body: JSON.stringify({ query: "in:inbox" }) }),
      ctx(CH_A),
    );
    expect(res.status).toBe(401);
  });
});

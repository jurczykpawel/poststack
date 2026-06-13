import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { createHash } from "crypto";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { licenseInstance } from "@/lib/license/__fixtures__/license-instance";

// Force the manual-reply enqueue to throw, so an unhandled error escapes the handler and we
// can assert the global onError still honours the { data, error } JSON contract.
vi.mock("@/lib/queue/client", () => ({
  addJobTx: () => { throw new Error("queue exploded: secret-connection-string"); },
  closeQueue: async () => {},
}));

const TEST_DB = process.env.TEST_DATABASE_URL;
const RAW_KEY = "sk_live_err_envelope_key_0123456789ab";
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let app: Hono;

const WS = "cccccccc-0000-0000-0000-0000000000f1";
const CH = "cccccccc-0000-0000-0000-0000000000f2";
const CONTACT = "cccccccc-0000-0000-0000-0000000000f3";
const CONV = "cccccccc-0000-0000-0000-0000000000f4";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  app = (await import("./app")).buildApp();
  // The manual-reply endpoint is PRO-gated; license the instance so the request reaches the
  // handler body (where the mocked enqueue throws) instead of stopping at the 402 gate.
  await licenseInstance();
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.insert(s.workspaces).values({ id: WS, name: "E", slug: `e-${WS}` });
  await db.insert(s.channels).values({ id: CH, workspace_id: WS, platform: "facebook", platform_id: "PG-E", token_encrypted: "x", webhook_secret: "s" });
  await db.insert(s.contacts).values({ id: CONTACT, workspace_id: WS });
  await db.insert(s.contactChannels).values({ contact_id: CONTACT, channel_id: CH, platform_sender_id: "PSID-E" });
  await db.insert(s.conversations).values({ id: CONV, workspace_id: WS, channel_id: CH, contact_id: CONTACT, platform: "facebook" });
  await db.insert(s.apiKeys).values({ workspace_id: WS, name: "k", key_hash: createHash("sha256").update(RAW_KEY).digest("hex"), key_prefix: "sk_live_err" });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.delete(s.instanceLicense);
});

describe("API error envelope", () => {
  it("maps an unhandled handler error to a JSON 500 envelope without leaking internals", async () => {
    if (!TEST_DB) return;
    const res = await app.request(`/api/v1/conversations/${CONV}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${RAW_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body.data).toBeNull();
    expect(body.error?.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(body)).not.toContain("secret-connection-string"); // no leak
  });
});

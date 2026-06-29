import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createHmac } from "crypto";
import { Pool } from "pg";
import { runMigrations } from "graphile-worker";
import { desc } from "drizzle-orm";
import { webhookEvents } from "@/db/schema";

// OBS1 (real Postgres): assert that the GET handshake and every POST request refused BEFORE event
// classification land a durable `webhook_events` row — with the new handshake_*/rejected_* status,
// a sanitized reason, and NO raw body. Mirrors smoke.integration.test.ts' harness.

const TEST_DB = process.env.TEST_DATABASE_URL;
const APP_SECRET = "obs-int-app-secret";
const VERIFY = "obs-int-verify-token";

let pool: Pool;
let db: typeof import("@/lib/db").db;
let GET: typeof import("./route").GET;
let POST: typeof import("./route").POST;
let resetRejectionLogThrottle: typeof import("@/lib/webhook-events/log-throttle").resetRejectionLogThrottle;

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  process.env.META_APP_ID = "app-id";
  process.env.META_APP_SECRET = APP_SECRET;
  process.env.META_WEBHOOK_VERIFY_TOKEN = VERIFY;

  pool = new Pool({ connectionString: TEST_DB });
  await runMigrations({ connectionString: TEST_DB });

  ({ db } = await import("@/lib/db"));
  ({ GET, POST } = await import("./route"));
  ({ resetRejectionLogThrottle } = await import("@/lib/webhook-events/log-throttle"));
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.delete(webhookEvents);
  // Start each test from a full throttle budget (the buckets are process-global module state).
  resetRejectionLogThrottle();
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.$client.end();
  await pool.end();
});

async function latest() {
  const [row] = await db.select().from(webhookEvents).orderBy(desc(webhookEvents.received_at)).limit(1);
  return row;
}

function getReq(token: string | undefined, mode = "subscribe") {
  const u = new URL("http://x/api/webhooks/meta");
  u.searchParams.set("hub.mode", mode);
  if (token !== undefined) u.searchParams.set("hub.verify_token", token);
  u.searchParams.set("hub.challenge", "PING-OBS");
  return new Request(u);
}

const sign = (body: string) => `sha256=${createHmac("sha256", APP_SECRET).update(body, "utf8").digest("hex")}`;

function postReq(body: string, signature?: string) {
  return new Request("http://x/api/webhooks/meta", {
    method: "POST",
    headers: { "content-type": "application/json", ...(signature ? { "x-hub-signature-256": signature } : {}) },
    body,
  });
}

describe("OBS1 handshake observability (real Postgres)", () => {
  it("records handshake_ok for a correct verify token", async () => {
    if (!TEST_DB) return;
    const res = await GET(getReq(VERIFY));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("PING-OBS");
    const row = await latest();
    expect(row.handling_status).toBe("handshake_ok");
    expect(row.event_type).toBe("handshake_ok");
  });

  it("records handshake_fail for a wrong verify token (and never stores the token)", async () => {
    if (!TEST_DB) return;
    const res = await GET(getReq("the-wrong-token"));
    expect(res.status).toBe(403);
    const row = await latest();
    expect(row.handling_status).toBe("handshake_fail");
    expect(JSON.stringify(row.raw)).not.toContain("the-wrong-token");
    expect(row.error_detail).not.toContain("the-wrong-token");
  });
});

describe("OBS1 rejected-before-record observability (real Postgres)", () => {
  it("records rejected_signature for a bad HMAC + does not store the body", async () => {
    if (!TEST_DB) return;
    const body = JSON.stringify({ object: "page", entry: [{ id: "SECRET_PAGE", messaging: [{ message: { text: "secret dm" } }] }] });
    const res = await POST(postReq(body, "sha256=deadbeef"));
    expect(res.status).toBe(403);
    const row = await latest();
    expect(row.handling_status).toBe("rejected_signature");
    expect(row.event_type).toBe("rejected_signature");
    // PII guard: only the byte length is kept, never the unverified body content.
    expect(JSON.stringify(row.raw)).not.toContain("secret dm");
    expect((row.raw as { bodyLength: number }).bodyLength).toBe(Buffer.byteLength(body));
  });

  it("records rejected_parse for a correctly-signed but unparseable body", async () => {
    if (!TEST_DB) return;
    const body = "not-json{";
    const res = await POST(postReq(body, sign(body)));
    expect(res.status).toBe(400);
    expect((await latest()).handling_status).toBe("rejected_parse");
  });

  it("records rejected_object for an unknown object type, keeping the object", async () => {
    if (!TEST_DB) return;
    const body = JSON.stringify({ object: "weather_station", entry: [] });
    const res = await POST(postReq(body, sign(body)));
    expect(res.status).toBe(200);
    const row = await latest();
    expect(row.handling_status).toBe("rejected_object");
    expect(row.object).toBe("weather_station");
  });

  it("records rejected_too_large for an oversized declared Content-Length", async () => {
    if (!TEST_DB) return;
    const bigReq = {
      headers: { get: (k: string) => (k.toLowerCase() === "content-length" ? "2000000" : null) },
      text: async () => "",
    } as unknown as Request;
    const res = await POST(bigReq);
    expect(res.status).toBe(413);
    expect((await latest()).handling_status).toBe("rejected_too_large");
  });

  it("each rejection is its own row (no dedup collapses repeated hits)", async () => {
    if (!TEST_DB) return;
    await POST(postReq(JSON.stringify({ object: "page", entry: [] }), "sha256=deadbeef"));
    await POST(postReq(JSON.stringify({ object: "page", entry: [] }), "sha256=deadbeef"));
    const rows = await db.select().from(webhookEvents);
    expect(rows.length).toBe(2);
  });
});

describe("OBS1 follow-up: the unauthenticated rejection log is throttled (real Postgres)", () => {
  const badSig = () => postReq(JSON.stringify({ object: "page", entry: [] }), "sha256=deadbeef");

  it("a BURST of bad requests does NOT write one webhook_events row per request", async () => {
    if (!TEST_DB) return;
    const N = 60;
    for (let i = 0; i < N; i++) {
      const res = await POST(badSig());
      expect(res.status).toBe(403); // throttle never changes the returned status code
    }
    const rows = await db.select().from(webhookEvents);
    // Bounded by the per-IP token bucket (30/min) — far fewer rows than requests = no amplification.
    expect(rows.length).toBeLessThan(N);
    expect(rows.length).toBeLessThanOrEqual(30);
    expect(rows.length).toBeGreaterThan(0); // genuine rejections are still recorded
  });

  it("a single sporadic rejection IS still recorded", async () => {
    if (!TEST_DB) return;
    const res = await POST(badSig());
    expect(res.status).toBe(403);
    expect((await db.select().from(webhookEvents)).length).toBe(1);
  });
});

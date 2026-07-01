import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { createHmac } from "crypto";

// OBS1: the GET handshake and every POST request refused BEFORE event classification must leave a
// trace. These unit tests mock the log sink and assert the route calls it with the right status; the
// real `webhook_events` rows are asserted in observability.integration.test.ts. db/queue are never
// touched on the rejection paths, so no Postgres is needed here (this file runs in the infra-free gate).

const APP_SECRET = "obs-unit-app-secret";
const VERIFY = "obs-unit-verify-token";

const logWebhookMeta = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/webhook-events/log", () => ({
  logWebhookMeta: (...args: unknown[]) => logWebhookMeta(...args),
  // The rejection paths return before classification, so these are never invoked here.
  classifyMessagingEvent: vi.fn(),
  classifyChangeEvent: vi.fn(),
}));

let GET: typeof import("./route").GET;
let POST: typeof import("./route").POST;
let resetRejectionLogThrottle: typeof import("@/lib/webhook-events/log-throttle").resetRejectionLogThrottle;

beforeAll(async () => {
  process.env.META_APP_SECRET = APP_SECRET;
  process.env.META_WEBHOOK_VERIFY_TOKEN = VERIFY;
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  process.env.DATABASE_URL = "postgres://test:test@localhost:5433/test";
  ({ GET, POST } = await import("./route"));
  ({ resetRejectionLogThrottle } = await import("@/lib/webhook-events/log-throttle"));
});

// Each test starts from a full throttle budget so cross-test token depletion can't make a single
// expected log silently get dropped.
beforeEach(() => {
  logWebhookMeta.mockClear();
  resetRejectionLogThrottle();
});

const sign = (body: string) => `sha256=${createHmac("sha256", APP_SECRET).update(body, "utf8").digest("hex")}`;

const getReq = (token?: string, mode = "subscribe") => {
  const u = new URL("http://x/api/webhooks/meta");
  u.searchParams.set("hub.mode", mode);
  if (token !== undefined) u.searchParams.set("hub.verify_token", token);
  u.searchParams.set("hub.challenge", "PING-OBS");
  return new Request(u);
};

const postReq = (body: string, signature?: string) =>
  new Request("http://x/api/webhooks/meta", {
    method: "POST",
    headers: { "content-type": "application/json", ...(signature ? { "x-hub-signature-256": signature } : {}) },
    body,
  });

const lastStatus = () => logWebhookMeta.mock.calls.at(-1)?.[0];

describe("OBS1: handshake observability (GET)", () => {
  it("logs handshake_ok when the verify token matches", async () => {
    const res = await GET(getReq(VERIFY));
    expect(res.status).toBe(200);
    expect(logWebhookMeta).toHaveBeenCalledTimes(1);
    expect(lastStatus()).toBe("handshake_ok");
  });

  it("logs handshake_fail when the verify token is wrong", async () => {
    const res = await GET(getReq("wrong-token"));
    expect(res.status).toBe(403);
    expect(lastStatus()).toBe("handshake_fail");
  });

  it("logs handshake_fail when hub.mode is not subscribe", async () => {
    const res = await GET(getReq(VERIFY, "unsubscribe"));
    expect(res.status).toBe(403);
    expect(lastStatus()).toBe("handshake_fail");
  });
});

describe("OBS1: rejected-before-record observability (POST)", () => {
  it("logs rejected_too_large for an oversized declared Content-Length", async () => {
    const bigReq = {
      headers: { get: (k: string) => (k.toLowerCase() === "content-length" ? "2000000" : null) },
      text: async () => "",
    } as unknown as Request;
    const res = await POST(bigReq);
    expect(res.status).toBe(413);
    expect(lastStatus()).toBe("rejected_too_large");
  });

  it("logs rejected_too_large for an oversized chunked body (no Content-Length)", async () => {
    const bigReq = {
      headers: { get: () => null },
      text: async () => "x".repeat(2_000_000),
    } as unknown as Request;
    const res = await POST(bigReq);
    expect(res.status).toBe(413);
    expect(lastStatus()).toBe("rejected_too_large");
  });

  it("logs rejected_signature for a bad HMAC signature", async () => {
    const res = await POST(postReq(JSON.stringify({ object: "page", entry: [] }), "sha256=deadbeef"));
    expect(res.status).toBe(403);
    expect(lastStatus()).toBe("rejected_signature");
  });

  it("logs rejected_parse for an unparseable (but correctly signed) body", async () => {
    const body = "this is not json{";
    const res = await POST(postReq(body, sign(body)));
    expect(res.status).toBe(400);
    expect(lastStatus()).toBe("rejected_parse");
  });

  it("logs rejected_object for an unknown object type", async () => {
    const body = JSON.stringify({ object: "weather_station", entry: [] });
    const res = await POST(postReq(body, sign(body)));
    expect(res.status).toBe(200); // returned as {status:"ignored"} but now recorded
    expect(lastStatus()).toBe("rejected_object");
    // PII guard: the object type is passed through for the operator, never raw body content.
    expect(logWebhookMeta.mock.calls.at(-1)?.[1]).toMatchObject({ object: "weather_station" });
  });

  it("logs a SIGNED unsupported-object event even when the throttle is exhausted, surfacing the tested field (Meta dashboard Test)", async () => {
    // A Meta dashboard "Test" POSTs a bare { field, value } — no object → unsupported — but it is
    // signature-verified, so we must still KNOW it arrived (owner rule). Unlike a bad-signature reject,
    // this is trusted Meta traffic, so it bypasses the pre-verification rejection-log throttle.
    for (let i = 0; i < 100; i++) await POST(postReq(JSON.stringify({ object: "page", entry: [] }), "sha256=deadbeef"));
    logWebhookMeta.mockClear();
    const body = JSON.stringify({ field: "message_reactions", value: { reaction: { emoji: "❤️" } } });
    const res = await POST(postReq(body, sign(body)));
    expect(res.status).toBe(200);
    expect(lastStatus()).toBe("rejected_object"); // logged despite the exhausted throttle
    expect(JSON.stringify(logWebhookMeta.mock.calls.at(-1)?.[1])).toContain("message_reactions"); // tested field surfaced
  });
});

describe("OBS1 follow-up: throttling the unauthenticated rejection log", () => {
  const badSig = () => postReq(JSON.stringify({ object: "page", entry: [] }), "sha256=deadbeef");

  it("caps log writes for a BURST of bad requests (not one write per request)", async () => {
    const N = 60;
    for (let i = 0; i < N; i++) {
      const res = await POST(badSig());
      expect(res.status).toBe(403); // status code is unaffected by the throttle
    }
    // The flood is bounded by the per-IP token bucket (30/min), so the number of DB-write attempts
    // is far below the number of requests — no row-per-request amplification.
    expect(logWebhookMeta.mock.calls.length).toBeLessThan(N);
    expect(logWebhookMeta.mock.calls.length).toBeLessThanOrEqual(30);
    expect(logWebhookMeta.mock.calls.length).toBeGreaterThan(0); // genuine ones still captured
  });

  it("still logs a single sporadic rejection", async () => {
    const res = await POST(badSig());
    expect(res.status).toBe(403);
    expect(logWebhookMeta).toHaveBeenCalledTimes(1);
  });
});

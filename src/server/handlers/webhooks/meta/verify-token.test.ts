import { describe, it, expect, beforeAll } from "vitest";

let GET: typeof import("./route").GET;
const VERIFY = "the-correct-verify-token-value";

beforeAll(async () => {
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.TOKEN_ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5433/test";
  process.env.META_WEBHOOK_VERIFY_TOKEN = VERIFY;
  ({ GET } = await import("./route"));
});

const req = (token?: string) => {
  const u = new URL("http://x/api/webhooks/meta");
  u.searchParams.set("hub.mode", "subscribe");
  if (token !== undefined) u.searchParams.set("hub.verify_token", token);
  u.searchParams.set("hub.challenge", "PING-1234");
  return new Request(u);
};

// the verify-token compare must be constant-time (timingSafeEqual over SHA-256 digests),
// like the CRON/HMAC checks. These assert the functional contract; equal-length and wrong-length
// tokens both reject without short-circuiting or throwing.
describe("Meta webhook hub verification", () => {
  it("echoes the challenge for the correct verify token", async () => {
    const res = await GET(req(VERIFY));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("PING-1234");
  });

  it("rejects a wrong token of equal length", async () => {
    const wrong = "x".repeat(VERIFY.length);
    expect(wrong.length).toBe(VERIFY.length);
    const res = await GET(req(wrong));
    expect(res.status).toBe(403);
  });

  it("rejects a wrong-length token without throwing (digests equalise length)", async () => {
    const res = await GET(req("short"));
    expect(res.status).toBe(403);
  });

  it("rejects when no verify token is supplied", async () => {
    const res = await GET(req(undefined));
    expect(res.status).toBe(403);
  });
});

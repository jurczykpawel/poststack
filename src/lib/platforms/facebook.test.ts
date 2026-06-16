import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

// facebook.ts transitively loads `@/lib/env` (validated at import); set required vars first.
let FacebookProvider: typeof import("./facebook").FacebookProvider;

const calls: Array<{ url: string; init?: RequestInit }> = [];
const realFetch = globalThis.fetch;

beforeAll(async () => {
  process.env.DATABASE_URL = "postgres://localhost/x";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  ({ FacebookProvider } = await import("./facebook"));
});

beforeEach(() => {
  calls.length = 0;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({ message_id: "m1" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("FacebookProvider.sendMessage messaging window", () => {
  const send = (call: { init?: RequestInit }) => JSON.parse(call.init!.body as string);

  it("defaults to messaging_type RESPONSE (within the 24h window)", async () => {
    const fb = new FacebookProvider();
    await fb.sendMessage({ access_token: "tok" }, "PSID-1", { text: "hi" });
    const body = send(calls.find((c) => c.url.includes("/me/messages"))!);
    expect(body.messaging_type).toBe("RESPONSE");
    expect(body.tag).toBeUndefined();
  });

  it("uses MESSAGE_TAG + HUMAN_AGENT when the tag is requested (past the 24h window)", async () => {
    const fb = new FacebookProvider();
    await fb.sendMessage({ access_token: "tok" }, "PSID-1", { text: "late reply" }, { messagingTag: "HUMAN_AGENT" });
    const body = send(calls.find((c) => c.url.includes("/me/messages"))!);
    expect(body.messaging_type).toBe("MESSAGE_TAG");
    expect(body.tag).toBe("HUMAN_AGENT");
  });
});

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

// instagram.ts transitively loads `@/lib/env` (validated at import), so set the required vars
// and import the provider dynamically once they're in place.
let InstagramProvider: typeof import("./instagram").InstagramProvider;

const calls: Array<{ url: string; init?: RequestInit }> = [];
const realFetch = globalThis.fetch;

beforeAll(async () => {
  process.env.DATABASE_URL = "postgres://localhost/x";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  ({ InstagramProvider } = await import("./instagram"));
});

beforeEach(() => {
  calls.length = 0;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({ success: true }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("InstagramProvider.subscribePageWebhooks", () => {
  it("subscribes the `comments` field so IG media-comment automation fires", async () => {
    const ig = new InstagramProvider();
    await ig.subscribePageWebhooks("PAGE-1", "page-token");

    const call = calls.find((c) => c.url.includes("/subscribed_apps"))!;
    expect(call).toBeDefined();
    const fields = JSON.parse(call.init!.body as string).subscribed_fields.split(",");
    expect(fields).toContain("comments");
    expect(fields).toContain("messages");
    expect(fields).toContain("messaging_postbacks");
  });
});

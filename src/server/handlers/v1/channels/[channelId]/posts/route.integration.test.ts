import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import { createHash } from "crypto";
import { eq } from "drizzle-orm";

const TEST_DB = process.env.TEST_DATABASE_URL;
const RAW_KEY = "rs_live_posts_route_key_abcdef0123";

let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let encryptTokens: typeof import("@/lib/crypto").encryptTokens;
let GET: typeof import("./route").GET;

const WS = "aaaaaaaa-0000-4000-8000-0000000000c1";
const CH_FB = "aaaaaaaa-0000-4000-8000-0000000000c2";
const CH_IG = "aaaaaaaa-0000-4000-8000-0000000000c3";

const realFetch = globalThis.fetch;
let lastUrl = "";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.TOKEN_ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  ({ encryptTokens } = await import("@/lib/crypto"));
  ({ GET } = await import("./route"));
});

beforeEach(async () => {
  if (!TEST_DB) return;
  lastUrl = "";
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.insert(s.workspaces).values({ id: WS, name: "P", slug: `p-${WS}` });
  const tok = encryptTokens({ access_token: "tok-abc" });
  await db.insert(s.channels).values([
    { id: CH_FB, workspace_id: WS, platform: "facebook", platform_id: "FBPAGE", token_encrypted: tok, webhook_secret: "s1" },
    { id: CH_IG, workspace_id: WS, platform: "instagram", platform_id: "IGUSER", token_encrypted: tok, webhook_secret: "s2" },
  ]);
  await db.insert(s.apiKeys).values({ workspace_id: WS, name: "k", key_hash: createHash("sha256").update(RAW_KEY).digest("hex"), key_prefix: "rs_live_po" });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
});

const req = () => new Request("http://x/api/v1/channels/x/posts", { headers: { authorization: `Bearer ${RAW_KEY}` } });
const ctx = (channelId: string) => ({ params: Promise.resolve({ channelId }) });
function mockFetch(body: unknown) {
  globalThis.fetch = vi.fn(async (u: unknown) => {
    lastUrl = String(u);
    return Response.json(body);
  }) as unknown as typeof fetch;
}
// A lone (unpaired) UTF-16 surrogate anywhere in the string.
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("GET /channels/:id/posts — platform-aware endpoint", () => {
  it("uses /feed for a Facebook channel", async () => {
    if (!TEST_DB) return;
    mockFetch({ data: [] });
    const res = await GET(req(), ctx(CH_FB));
    expect(res.status).toBe(200);
    expect(lastUrl).toContain("/FBPAGE/feed?");
    expect(lastUrl).not.toContain("/media");
  });

  it("uses /media (not /feed) for an Instagram channel and normalizes the shape", async () => {
    if (!TEST_DB) return;
    mockFetch({ data: [{ id: "IGM1", caption: "hi there", timestamp: "2026-01-01T00:00:00+0000", media_url: "http://img/1", permalink: "http://link/1" }] });
    const res = await GET(req(), ctx(CH_IG));
    expect(res.status).toBe(200);
    expect(lastUrl).toContain("/IGUSER/media?");
    expect(lastUrl).not.toContain("/feed");
    const data = (await res.json()).data;
    expect(data[0]).toMatchObject({ id: "IGM1", text: "hi there", image: "http://img/1", url: "http://link/1" });
  });
});

describe("GET /channels/:id/posts — robustness", () => {
  it("returns 400 (not 500) when the channel token cannot be decrypted", async () => {
    if (!TEST_DB) return;
    await db.update(s.channels).set({ token_encrypted: "not-valid-ciphertext" }).where(eq(s.channels.id, CH_FB));
    // fetch must never be reached
    globalThis.fetch = vi.fn(async () => { throw new Error("should not fetch"); }) as unknown as typeof fetch;
    const res = await GET(req(), ctx(CH_FB));
    expect(res.status).toBe(400);
  });

  it("slices a long preview on code points so an emoji at the cut is not split", async () => {
    if (!TEST_DB) return;
    // One ASCII char then emojis → a UTF-16 slice at 100 lands mid-emoji (lone surrogate).
    const longMsg = "a" + "😀".repeat(120);
    mockFetch({ data: [{ id: "P", message: longMsg, created_time: "t" }] });
    const res = await GET(req(), ctx(CH_FB));
    const data = (await res.json()).data;
    expect(loneSurrogate.test(data[0].text)).toBe(false);
    expect(data[0].text.endsWith("...")).toBe(true);
  });
});

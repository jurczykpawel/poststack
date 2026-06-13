import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let subscribeChannelWebhooks: typeof import("./subscribe").subscribeChannelWebhooks;
let SUBSCRIBE_FAILED_ERROR: string;
let encryptTokens: typeof import("@/lib/crypto").encryptTokens;

const WS = "ffff0000-0000-0000-0000-0000000fff01";
const realFetch = globalThis.fetch;

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  process.env.META_APP_ID = "111";
  process.env.META_APP_SECRET = "sec";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  ({ subscribeChannelWebhooks, SUBSCRIBE_FAILED_ERROR } = await import("./subscribe"));
  ({ encryptTokens } = await import("@/lib/crypto"));
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.insert(s.workspaces).values({ id: WS, name: "SUB", slug: `sub-${WS}` });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.$client.end();
});

async function seedChannel(platformId: string) {
  const [c] = await db
    .insert(s.channels)
    .values({
      workspace_id: WS,
      platform: "facebook",
      platform_id: platformId,
      connection_mode: "derived",
      status: "active",
      token_encrypted: encryptTokens({ access_token: "PT" }),
      webhook_secret: "wh",
    })
    .returning({ id: s.channels.id });
  return c!.id;
}

describe("subscribeChannelWebhooks — flags channels whose subscribe fails", () => {
  it("flags last_error on a non-ok subscribe (a silent no-inbound channel becomes visible)", async () => {
    if (!TEST_DB) return;
    const id = await seedChannel("FBX");
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/subscribed_apps")) return new Response("nope", { status: 403 });
      return new Response("Not Found", { status: 404 });
    }) as typeof fetch;

    const r = await subscribeChannelWebhooks(WS, "facebook", [
      { platformId: "FBX", displayName: "P", tokens: { access_token: "PT" } },
    ]);
    expect(r.failedPlatformIds).toEqual(["FBX"]);
    const ch = await db.query.channels.findFirst({ where: eq(s.channels.id, id) });
    expect(ch!.last_error).toBe(SUBSCRIBE_FAILED_ERROR);
  });

  it("leaves last_error clean on a successful subscribe", async () => {
    if (!TEST_DB) return;
    const id = await seedChannel("FBY");
    globalThis.fetch = vi.fn(async () => Response.json({ success: true })) as typeof fetch;
    const r = await subscribeChannelWebhooks(WS, "facebook", [
      { platformId: "FBY", displayName: "P", tokens: { access_token: "PT" } },
    ]);
    expect(r.failedPlatformIds).toEqual([]);
    const ch = await db.query.channels.findFirst({ where: eq(s.channels.id, id) });
    expect(ch!.last_error).toBeNull();
  });
});

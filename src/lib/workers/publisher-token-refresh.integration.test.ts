import { beforeAll, beforeEach, afterEach, afterAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { JobHelpers } from "graphile-worker";

const { addJob, dispatchAlert } = vi.hoisted(() => ({ addJob: vi.fn(), dispatchAlert: vi.fn() }));
vi.mock("@/lib/queue/client", () => ({ addJob, addJobTx: vi.fn(), closeQueue: vi.fn() }));
vi.mock("@/lib/notifications/alert", () => ({ dispatchAlert }));
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let crypto: typeof import("@/lib/crypto");
let scan: typeof import("./token-refresh-scan").scanExpiringTokens;
let refresh: typeof import("./token-refresh-worker").processTokenRefresh;
const WS = "eeeeeeee-0000-0000-0000-000000000091";
const helpers = { logger: { info: vi.fn() } } as unknown as JobHelpers;
beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.ENCRYPTION_KEY = "g9-encryption-key-at-least-32-characters";
  process.env.JWT_SECRET = "g9-jwt-secret-at-least-32-characters";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "g9-cron-secret-at-least-32-characters";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  crypto = await import("@/lib/crypto");
  ({ scanExpiringTokens: scan } = await import("./token-refresh-scan"));
  ({ processTokenRefresh: refresh } = await import("./token-refresh-worker"));
});
beforeEach(async () => {
  vi.clearAllMocks();
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.insert(s.workspaces).values({ id: WS, name: "G9", slug: "g9-refresh" });
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => { await db.delete(s.workspaces).where(eq(s.workspaces.id, WS)); });
async function seed(platform: "tiktok" | "linkedin" | "twitter" | "threads", seconds = -3600, refreshToken: string | undefined = "RT") {
  const expiresAt = Math.floor(Date.now() / 1000) + seconds;
  const [ch] = await db.insert(s.channels).values({
    workspace_id: WS, platform, platform_id: `g9-${platform}`, connection_mode: "oauth", status: "active",
    token_encrypted: crypto.encryptTokens({ access_token: "AT", refresh_token: refreshToken, expires_at: expiresAt, account_hint: "keep" }),
    token_expires_at: new Date(expiresAt * 1000), webhook_secret: "test",
  }).returning();
  return ch!;
}
const read = (id: string) => db.query.channels.findFirst({ where: eq(s.channels.id, id) });
describe("publisher token lifecycle", () => {
  it.each(["tiktok", "linkedin", "twitter", "threads"] as const)("scans and rotates %s before expiry", async (platform) => {
    const ch = await seed(platform, 1800);
    const fetch = vi.fn(async () => Response.json({ access_token: "NEW", refresh_token: "ROTATED", expires_in: 86400 }));
    vi.stubGlobal("fetch", fetch);
    await scan();
    expect(addJob).toHaveBeenCalledWith("token-refresh", { channelId: ch.id }, { jobKey: `token-refresh-${ch.id}` });
    await refresh({ channelId: ch.id }, helpers);
    const row = (await read(ch.id))!;
    expect(row.status).toBe("active");
    expect(row.token_expires_at!.getTime()).toBeGreaterThan(Date.now() + 80_000_000);
    expect(crypto.decryptTokens(row.token_encrypted)).toMatchObject({ access_token: "NEW", account_hint: "keep" });
    expect(fetch).toHaveBeenCalledTimes(1);
    if (platform !== "threads") expect(crypto.decryptTokens(row.token_encrypted).refresh_token).toBe("ROTATED");
  });
  it.each([
    ["tiktok", 200, "invalid_client", /application credentials rejected/],
    ["tiktok", 200, "invalid_grant", /invalid_grant/],
    ["linkedin", 400, "invalid_grant", /invalid_grant/],
    ["twitter", 400, "invalid_grant", /invalid_grant/],
  ] as const)("expired %s %s %s becomes needs_reauth with one alert", async (platform, status, error, reason) => {
    const ch = await seed(platform);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error, error_description: "Rejected", log_id: "20261101" }, { status })));
    await scan();
    expect(addJob).toHaveBeenCalledWith("token-refresh", { channelId: ch.id }, expect.anything());
    await refresh({ channelId: ch.id }, helpers);
    await refresh({ channelId: ch.id }, helpers);
    const row = (await read(ch.id))!;
    expect(row.status).toBe("needs_reauth");
    expect(row.needs_reauth_reason).toMatch(reason);
    expect(dispatchAlert).toHaveBeenCalledTimes(1);
    expect(dispatchAlert).toHaveBeenCalledWith(expect.objectContaining({ type: "channel_reauth", channelId: ch.id, detail: row.needs_reauth_reason }));
  });
  it("marks an expired LinkedIn channel without a refresh token", async () => {
    const ch = await seed("linkedin", -3600, undefined);
    // Explicitly omit the token (the helper's default is RT).
    await db.update(s.channels).set({ token_encrypted: crypto.encryptTokens({ access_token: "AT", expires_at: 1 }) }).where(eq(s.channels.id, ch.id));
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await refresh({ channelId: ch.id }, helpers);
    expect((await read(ch.id))!.status).toBe("needs_reauth");
    expect((await read(ch.id))!.needs_reauth_reason).toMatch(/refresh token missing/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("marks an expired Threads token which cannot be refreshed", async () => {
    const ch = await seed("threads");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { message: "Error validating access token: Session has expired", type: "OAuthException", code: 190 } }, { status: 400 })));
    await refresh({ channelId: ch.id }, helpers);
    expect((await read(ch.id))!.status).toBe("needs_reauth");
    expect(dispatchAlert).toHaveBeenCalledTimes(1);
  });
  it.each(["503", "network"])("keeps status and tokens for %s failures", async (failure) => {
    const ch = await seed("tiktok");
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (failure === "network") throw new Error("network unavailable");
      return new Response("Service Unavailable", { status: 503 });
    }));
    await expect(refresh({ channelId: ch.id }, helpers)).rejects.toThrow();
    expect((await read(ch.id))!.status).toBe("active");
    expect((await read(ch.id))!.token_encrypted).toBe(ch.token_encrypted);
    expect(dispatchAlert).not.toHaveBeenCalled();
  });
  it("uses the surfaced expiry when the stored blob has a later timestamp", async () => {
    const ch = await seed("tiktok");
    await db.update(s.channels).set({ token_encrypted: crypto.encryptTokens({ access_token: "AT", refresh_token: "RT", expires_at: Math.floor(Date.now() / 1000) + 60 * 86400 }) }).where(eq(s.channels.id, ch.id));
    await scan();
    expect(addJob).toHaveBeenCalledWith("token-refresh", { channelId: ch.id }, expect.anything());
  });
  it("does not enqueue a token outside the buffer", async () => {
    const ch = await seed("tiktok", 20 * 86400);
    await scan();
    expect(addJob.mock.calls.some((args) => args[1].channelId === ch.id)).toBe(false);
  });
});

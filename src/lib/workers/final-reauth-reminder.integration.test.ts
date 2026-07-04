import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";

// Mock the boundaries the scan touches; DB is real.
vi.mock("@/lib/queue/client", () => ({ addJob: vi.fn(async () => {}), closeQueue: vi.fn(async () => {}) }));
const dispatchAlert = vi.fn(async (_alert: { type: string; channelId?: string }) => {});
vi.mock("@/lib/notifications/alert", () => ({ dispatchAlert }));
// Registry stub so the messaging pass's getProvider("instagram").refreshBufferSeconds() resolves.
vi.mock("@/lib/platforms/registry", () => ({
  getProvider: () => ({ requiresTokenRefresh: () => true, refreshBufferSeconds: () => 0 }),
}));

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let scanExpiringTokens: typeof import("./token-refresh-scan").scanExpiringTokens;

const WS = "eeeeeeee-0000-0000-0000-0000000000c1";
const HOUR = 3600_000;

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  ({ scanExpiringTokens } = await import("./token-refresh-scan"));
});

beforeEach(async () => {
  if (!TEST_DB) return;
  dispatchAlert.mockClear();
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.insert(s.workspaces).values({ id: WS, name: "RR", slug: `rr-${WS}` });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
});

async function seed(id: string, status: string, expiresInMs: number | null) {
  await db.insert(s.channels).values({
    id, workspace_id: WS, platform: "linkedin", platform_id: `pid-${id}`,
    token_encrypted: "x", webhook_secret: "x", status: status as never, connection_mode: "oauth",
    token_expires_at: expiresInMs == null ? null : new Date(Date.now() + expiresInMs),
  });
}
const urgentCalls = () => dispatchAlert.mock.calls.filter((c) => c[0].type === "channel_reauth_urgent");

describe("final reauth reminder (scanExpiringTokens)", () => {
  const CH = "eeeeeeee-0000-0000-0000-0000000000c2";

  it("fires ONE channel_reauth_urgent for a needs_reauth channel within 24h of hard expiry", async () => {
    if (!TEST_DB) return;
    await seed(CH, "needs_reauth", 12 * HOUR);
    await scanExpiringTokens();
    const calls = urgentCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]![0].channelId).toBe(CH);
    // guard recorded on the row, keyed to this expiry
    const ch = await db.query.channels.findFirst({ where: eq(s.channels.id, CH), columns: { metadata: true, token_expires_at: true } });
    expect((ch!.metadata as Record<string, unknown>).finalReauthReminderForExpiry).toBe(ch!.token_expires_at!.toISOString());
  });

  it("does not re-fire on the next scan (once per expiry)", async () => {
    if (!TEST_DB) return;
    await seed(CH, "needs_reauth", 12 * HOUR);
    await scanExpiringTokens();
    dispatchAlert.mockClear();
    await scanExpiringTokens();
    expect(urgentCalls()).toHaveLength(0);
  });

  it("does not fire when expiry is still more than 24h away", async () => {
    if (!TEST_DB) return;
    await seed(CH, "needs_reauth", 3 * 24 * HOUR);
    await scanExpiringTokens();
    expect(urgentCalls()).toHaveLength(0);
  });

  it("does not fire for an already-expired token", async () => {
    if (!TEST_DB) return;
    await seed(CH, "needs_reauth", -1 * HOUR);
    await scanExpiringTokens();
    expect(urgentCalls()).toHaveLength(0);
  });

  it("does not fire for an active channel (only needs_reauth)", async () => {
    if (!TEST_DB) return;
    await seed(CH, "active", 12 * HOUR);
    await scanExpiringTokens();
    expect(urgentCalls()).toHaveLength(0);
  });
});

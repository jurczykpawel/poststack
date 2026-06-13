import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let scan: typeof import("./expiry-scan");
let encryptTokens: typeof import("@/lib/crypto").encryptTokens;
let closeQueue: typeof import("@/lib/queue/client").closeQueue;

const WS = "cccccccc-0000-0000-0000-0000000000c1";
const realFetch = globalThis.fetch;
const DAY = 24 * 60 * 60 * 1000;

// Capture the alert POSTs (dispatchAlert posts to CHANNEL_ALERT_WEBHOOK_URL).
let alertBodies: Array<Record<string, unknown>>;

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  process.env.CHANNEL_ALERT_WEBHOOK_URL = "https://example.com/alert-hook";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  scan = await import("./expiry-scan");
  ({ encryptTokens } = await import("@/lib/crypto"));
  ({ closeQueue } = await import("@/lib/queue/client"));
});

beforeEach(async () => {
  if (!TEST_DB) return;
  alertBodies = [];
  globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.body) alertBodies.push(JSON.parse(String(init.body)));
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.insert(s.workspaces).values({ id: WS, name: "EX", slug: `ex-${WS}` });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  delete process.env.CHANNEL_ALERT_WEBHOOK_URL;
  if (closeQueue) await closeQueue();
});

async function source(over: Partial<typeof s.accountSources.$inferInsert> = {}) {
  const [row] = await db
    .insert(s.accountSources)
    .values({
      workspace_id: WS,
      provider: "meta",
      provider_account_id: `acc-${Math.random().toString(36).slice(2)}`,
      kind: "user",
      token_encrypted: encryptTokens({ access_token: "t" }),
      status: "active",
      ...over,
    })
    .returning({ id: s.accountSources.id });
  return row.id;
}

describe("scanExpiringConnections (real Postgres)", () => {
  it("alerts on a source whose data-access wall is inside the 7-day window", async () => {
    if (!TEST_DB) return;
    await source({ display_name: "Acme", data_access_expires_at: new Date(Date.now() + 3 * DAY) });
    const r = await scan.scanExpiringConnections();
    expect(r.alerted).toBe(1);
    expect(alertBodies).toHaveLength(1);
    expect(alertBodies[0]).toMatchObject({ type: "token_expiring", days_left: 3, display_name: "Acme" });
  });

  it("does NOT alert on a wall far in the future", async () => {
    if (!TEST_DB) return;
    await source({ data_access_expires_at: new Date(Date.now() + 60 * DAY) });
    expect((await scan.scanExpiringConnections()).alerted).toBe(0);
  });

  it("never alerts a System User source (no wall → NULL data_access_expires_at)", async () => {
    if (!TEST_DB) return;
    await source({ kind: "system_user", data_access_expires_at: null });
    expect((await scan.scanExpiringConnections()).alerted).toBe(0);
  });

  it("skips a disabled source even if its wall is near", async () => {
    if (!TEST_DB) return;
    await source({ status: "disabled", data_access_expires_at: new Date(Date.now() + 1 * DAY) });
    expect((await scan.scanExpiringConnections()).alerted).toBe(0);
  });
});

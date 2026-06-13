import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { licenseInstance } from "@/lib/license/__fixtures__/license-instance";

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let enforce: typeof import("./api-key-enforcement").enforceApiKeyLicense;
let gate: typeof import("@/lib/license/gate");
let closeQueue: typeof import("@/lib/queue/client").closeQueue;

const WS = "f1f1f1f1-0000-0000-0000-0000000000f1";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  ({ enforceApiKeyLicense: enforce } = await import("./api-key-enforcement"));
  gate = await import("@/lib/license/gate");
  ({ closeQueue } = await import("@/lib/queue/client"));
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.insert(s.workspaces).values({ id: WS, name: "EN", slug: `en-${WS}` });
  await db.delete(s.instanceLicense);
  gate.invalidateLicenseCache();
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.delete(s.instanceLicense);
  gate.invalidateLicenseCache();
  if (closeQueue) await closeQueue();
});

async function key(name: string, expires_at: Date | null) {
  const [row] = await db
    .insert(s.apiKeys)
    .values({ workspace_id: WS, name, key_hash: `h-${name}-${Math.random()}`, key_prefix: `sk_live_${name}`, expires_at })
    .returning({ id: s.apiKeys.id });
  return row.id;
}
async function expiryOf(id: string) {
  const r = await db.query.apiKeys.findFirst({ where: eq(s.apiKeys.id, id), columns: { expires_at: true } });
  return r?.expires_at ?? null;
}

describe("enforceApiKeyLicense (real Postgres)", () => {
  it("expires still-valid keys when the instance is NOT licensed for api_access (downgrade)", async () => {
    if (!TEST_DB) return;
    const noExpiry = await key("k1", null);
    const future = await key("k2", new Date(Date.now() + 30 * 24 * 60 * 60 * 1000));
    const alreadyPast = await key("k3", new Date("2020-01-01T00:00:00Z"));

    const now = new Date();
    const r = await enforce(now);
    expect(r.expired).toBe(2); // k1 + k2

    expect(await expiryOf(noExpiry)).toEqual(now);
    expect(await expiryOf(future)).toEqual(now);
    expect(await expiryOf(alreadyPast)).toEqual(new Date("2020-01-01T00:00:00Z")); // untouched
  });

  it("leaves keys untouched when the instance IS licensed for api_access (PRO)", async () => {
    if (!TEST_DB) return;
    const k = await key("k1", null);
    await licenseInstance("pro");
    const r = await enforce();
    expect(r.expired).toBe(0);
    expect(await expiryOf(k)).toBeNull();
  });
});

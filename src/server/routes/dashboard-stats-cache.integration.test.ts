import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";

// STATSCACHE1 wiring test (cache ON). The other integration tests run with STATS_CACHE_TTL_MS=0
// (set in vitest.integration.config.ts) so they read live DB state. THIS file overrides it to a
// positive TTL *before* importing dashboard — so the module-level memo is live — and proves that
// loadWebhookStats memoizes per channel key: a second call within the window returns the cached
// snapshot (does not see a row inserted after the first call), and a different key computes fresh.

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let schema: typeof import("@/db/schema");
let encryptTokens: typeof import("@/lib/crypto").encryptTokens;
let seedWorkspace: typeof import("../../../tests/helpers/workspace").seedWorkspace;
let loadWebhookStats: typeof import("./dashboard").loadWebhookStats;
let WS = "", CH_A = "", CH_B = "";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY = "test-encryption-key-at-least-32-characters-long";
  process.env.JWT_SECRET ??= "test-secret-at-least-32-characters-long";
  process.env.APP_URL ??= "http://localhost:3000";
  process.env.CRON_SECRET ??= "test-cron-secret-at-least-32-characters-long";
  // Override the suite-wide STATS_CACHE_TTL_MS=0: this must be set BEFORE dashboard (→ env) imports.
  process.env.STATS_CACHE_TTL_MS = "60000";
  ({ db } = await import("@/lib/db"));
  schema = await import("@/db/schema");
  ({ encryptTokens } = await import("@/lib/crypto"));
  ({ seedWorkspace } = await import("../../../tests/helpers/workspace"));
  ({ loadWebhookStats } = await import("./dashboard"));
});
afterAll(async () => { if (TEST_DB) { await db.delete(schema.workspaces).where(eq(schema.workspaces.id, WS)); await db.$client.end(); } });
beforeEach(async () => {
  if (!TEST_DB) return;
  if (WS) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, WS));
  WS = await seedWorkspace(db, schema, { slug: `whc-${Math.random().toString(36).slice(2)}` });
  const made: string[] = [];
  for (let i = 0; i < 2; i++) {
    const [c] = await db.insert(schema.channels).values({
      workspace_id: WS, platform: "instagram", platform_id: `ig-${Math.random()}`,
      connection_mode: "oauth", status: "active",
      token_encrypted: encryptTokens({ access_token: "T" }), webhook_secret: "wh",
    }).returning({ id: schema.channels.id });
    made.push(c!.id);
  }
  [CH_A, CH_B] = made as [string, string];
});

async function addEvent(channelId: string) {
  await db.insert(schema.webhookEvents).values({
    event_key: `k-${Math.random()}`, event_type: "comments", raw: {}, channel_id: channelId,
    platform: "instagram", handling_status: "fired",
  });
}

describe("loadWebhookStats memoization (cache ON)", () => {
  it("serves a stale snapshot within the TTL, and computes a fresh value for a different key", async () => {
    if (!TEST_DB) { expect(true).toBe(true); return; }

    await addEvent(CH_A); // CH_A has 1 event
    const first = await loadWebhookStats([CH_A]);
    expect(first.total).toBe(1); // computed + cached under key "CH_A"

    await addEvent(CH_A); // CH_A now has 2 events in the DB
    const second = await loadWebhookStats([CH_A]);
    expect(second.total).toBe(1); // STILL 1 — served from cache, the new row is not seen

    // A different channel set is a different cache key → fresh compute over real DB state.
    await addEvent(CH_B); // CH_B has 1 event
    const other = await loadWebhookStats([CH_B]);
    expect(other.total).toBe(1);
  });
});

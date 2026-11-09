import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
vi.mock("@/lib/license/gate", () => ({ requireFeature: vi.fn() }));
const POOL_MAX = 4;
const ws = randomUUID();
const refs = Array.from({ length: POOL_MAX }, () => ({ workspaceId: ws, channelId: randomUUID() }));
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let lifecycle: typeof import("./lifecycle");
let repo: typeof import("./repository");
let revision: string;

/** Fails instead of hanging when the pool is starved (the pool has no acquire timeout). */
function within<T>(work: Promise<T>, ms = 8000): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("pool starved: transactions did not finish")), ms); });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.DB_POOL_MAX = String(POOL_MAX);
  process.env.ENCRYPTION_KEY = "test-insights-encryption-passphrase-32characters";
  process.env.JWT_SECRET = "test-jwt-secret-at-least-32-characters";
  ({ db } = await import("@/lib/db")); s = await import("@/db/schema");
  lifecycle = await import("./lifecycle"); repo = await import("./repository");
  const { encryptTokens } = await import("@/lib/crypto");
  const { insightCredentialRevision } = await import("./credentials");
  revision = insightCredentialRevision("facebook", "pool-user-token");
  await db.insert(s.workspaces).values({ id: ws, name: "Pool", slug: ws });
  await db.insert(s.channels).values(refs.map((ref, i) => ({
    id: ref.channelId, workspace_id: ws, platform: "instagram" as const, platform_id: `pool-${i}`, webhook_secret: "test",
    token_encrypted: encryptTokens({ access_token: "page", user_access_token: "pool-user-token" }),
  })));
  await db.insert(s.insightConnections).values(refs.map((ref) => ({
    workspace_id: ws, channel_id: ref.channelId, platform: "instagram" as const, collection_mode: "on" as const, transport: "facebook" as const, credential_revision: revision,
  })));
});
afterAll(async () => {
  // A starved pool leaves its transactions holding row locks; cut them off before cleanup.
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  try {
    await admin.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and state like 'idle in transaction%'");
    await admin.query("delete from workspaces where id = $1", [ws]);
  } finally { await admin.end(); }
});

it("reconciles credentials for as many channels as the pool has connections", async () => {
  await within(Promise.all(refs.map((ref) => lifecycle.reconcileInsightCredentials(ref))));
});
it("stores batches for as many channels as the pool has connections", async () => {
  const empty = { observations: [], usage: { percent: null, regainAfterSeconds: null } };
  await within(Promise.all(refs.map((ref) => repo.upsertInsightBatch(ref, revision, empty))));
  expect(await db.select().from(s.insightConnections).where(eq(s.insightConnections.workspace_id, ws))).toHaveLength(POOL_MAX);
});

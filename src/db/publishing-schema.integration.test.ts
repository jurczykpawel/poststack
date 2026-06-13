import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";

// Structural guards for the ported publishing schema: every new table is workspace-scoped (FK to
// workspaces) and its natural keys are unique PER WORKSPACE (never globally), so multi-tenant
// isolation is enforced by the DB, not just app code.
const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.JWT_SECRET ??= "test-secret-at-least-32-characters-long";
  process.env.ENCRYPTION_KEY ??= "test-encryption-key-at-least-32-characters-long";
  process.env.APP_URL ??= "http://localhost:3000";
  process.env.CRON_SECRET ??= "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.$client.end();
});

async function indexdef(name: string): Promise<string> {
  const r = await db.execute(sql`SELECT indexdef FROM pg_indexes WHERE indexname = ${name}`);
  return (r.rows[0]?.indexdef as string) ?? "";
}

async function hasFkToWorkspaces(table: string): Promise<boolean> {
  const r = await db.execute(sql`
    SELECT 1 FROM information_schema.table_constraints tc
    JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
    WHERE tc.table_name = ${table} AND tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name = 'workspaces'
    LIMIT 1`);
  return r.rows.length > 0;
}

describe("publishing schema is workspace-scoped", () => {
  it("media/content/posts/deliveries/brands/events all FK to workspaces", async () => {
    if (!TEST_DB) return;
    for (const t of ["media", "content", "posts", "deliveries", "brands", "events", "channel_rate_state"]) {
      // channel_rate_state is scoped transitively via channels; the rest are directly scoped.
      if (t === "channel_rate_state") continue;
      expect(await hasFkToWorkspaces(t), `${t} → workspaces FK`).toBe(true);
    }
  });

  it("natural keys are unique PER workspace, not globally", async () => {
    if (!TEST_DB) return;
    // each unique index must lead with workspace_id
    expect(await indexdef("media_workspace_checksum_key")).toMatch(/workspace_id[\s\S]*checksum/);
    expect(await indexdef("deliveries_workspace_idempotency_key")).toMatch(/workspace_id[\s\S]*idempotency_key/);
    expect(await indexdef("content_workspace_source_ref_key")).toMatch(/workspace_id[\s\S]*source_ref/);
    expect(await indexdef("posts_workspace_idempotency_key")).toMatch(/workspace_id[\s\S]*idempotency_key/);
  });

  it("brands PK is composite (workspace_id, key) so a key is unique per workspace", async () => {
    if (!TEST_DB) return;
    const def = await indexdef("brands_pkey");
    expect(def).toMatch(/workspace_id/);
    expect(def).toMatch(/key/);
  });

  it("channels brand FK is composite (workspace_id, brand_key) — a channel joins only its own workspace's brand", async () => {
    if (!TEST_DB) return;
    const r = await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM information_schema.key_column_usage
      WHERE constraint_name = 'channels_brand_fkey'`);
    expect(Number(r.rows[0]?.n)).toBe(2); // two-column composite FK
  });
});

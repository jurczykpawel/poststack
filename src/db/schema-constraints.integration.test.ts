import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";

const TEST_DB = process.env.TEST_DATABASE_URL;

let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");

const WS = "ffffffff-0000-0000-0000-0000000000a1";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.execute(sql`delete from workspaces where slug like 'raw-aud136-%'`);
});

//  — id / updated_at carry SQL-level DEFAULTs, so a non-ORM writer (NocoDB bulk insert, raw
// SQL, backfill) that omits them does not hit a NOT NULL violation.
describe("SQL-level defaults for non-ORM inserts", () => {
  it("a raw INSERT omitting id and updated_at succeeds (DB fills them)", async () => {
    if (!TEST_DB) return;
    const slug = `raw-aud136-${Date.now()}`;
    await db.execute(sql`insert into workspaces (name, slug) values ('Raw', ${slug})`);
    const row = await db.query.workspaces.findFirst({ where: eq(s.workspaces.slug, slug), columns: { id: true, updated_at: true } });
    expect(row?.id).toBeTruthy();
    expect(row?.updated_at).toBeInstanceOf(Date);
  });

  it("a raw INSERT into auto_reply_rules omitting id/updated_at succeeds", async () => {
    if (!TEST_DB) return;
    const slug = `raw-aud136-rule-${Date.now()}`;
    const [ws] = (await db.execute(
      sql`insert into workspaces (name, slug) values ('RawRule', ${slug}) returning id`,
    )).rows as Array<{ id: string }>;
    await db.execute(sql`
      insert into auto_reply_rules (workspace_id, name, trigger_type, trigger_config, response_type, response_config)
      values (${ws.id}, 'Raw rule', 'keyword', '{}'::jsonb, 'text', '{"text":"hi"}'::jsonb)
    `);
    const rules = await db.execute(sql`select id, updated_at from auto_reply_rules where workspace_id = ${ws.id}`);
    expect(rules.rows.length).toBe(1);
    expect((rules.rows[0] as { id: string }).id).toBeTruthy();
    expect((rules.rows[0] as { updated_at: unknown }).updated_at).toBeTruthy();
  });
});

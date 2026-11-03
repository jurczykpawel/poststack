import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

describe("post_previews reconciliation (POSTPREVIEW1)", () => {
  it("creates the table on an existing database and repeated runs keep it", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const client = await pool.connect();
    const shape = async () => (await client.query(
      `SELECT (SELECT count(*)::int FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'post_previews') AS columns,
              (SELECT count(*)::int FROM pg_constraint WHERE conrelid = to_regclass('post_previews') AND contype = 'f') AS fks,
              (SELECT count(*)::int FROM pg_indexes WHERE tablename = 'post_previews' AND indexname = 'post_previews_workspace_channel_post_key') AS uniq`,
    )).rows[0];
    try {
      await client.query("BEGIN");
      const migrated = await shape();
      expect(migrated).toEqual({ columns: 10, fks: 2, uniq: 1 });
      await client.query('DROP TABLE "post_previews"; DROP TYPE "post_preview_status"');
      expect((await shape()).columns).toBe(0);
      const delta = await readFile(new URL("./0021_post_previews.sql", import.meta.url), "utf8");
      await client.query(delta);
      await client.query(delta);
      expect(await shape()).toEqual(migrated);
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await pool.end();
    }
  });
});

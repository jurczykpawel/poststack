import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

describe("api_keys.created_by_user_id reconciliation", () => {
  it("adds the column + FK (ON DELETE SET NULL) to an existing database, keeps data on repeated runs", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const client = await pool.connect();
    const shape = async () =>
      (await client.query(`SELECT
        (SELECT data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'api_keys' AND column_name = 'created_by_user_id') AS col,
        (SELECT confdeltype FROM pg_constraint WHERE conname = 'api_keys_created_by_user_id_fkey') AS del`)).rows[0] as { col: string | null; del: string | null };
    try {
      await client.query("BEGIN");
      expect(await shape()).toEqual({ col: "uuid", del: "n" }); // fresh migrate already has it (folded into 0006)
      await client.query('ALTER TABLE "api_keys" DROP COLUMN "created_by_user_id"');
      expect(await shape()).toEqual({ col: null, del: null });
      const delta = await readFile(new URL("./0022_api_key_creator.sql", import.meta.url), "utf8");
      await client.query(delta);
      const user = randomUUID(), ws = randomUUID(), key = randomUUID();
      await client.query("INSERT INTO users(id, email) VALUES ($1, $2)", [user, `creator-${user}@test.local`]);
      await client.query("INSERT INTO workspaces(id, name, slug) VALUES ($1::uuid, 'Creator', $1::text)", [ws]);
      await client.query("INSERT INTO api_keys(id, workspace_id, name, key_hash, key_prefix, created_by_user_id) VALUES ($1, $2, 'k', $1::text, 'sk_live_t', $3)", [key, ws, user]);
      await client.query(delta); // second run: nothing breaks, data stays
      expect(await shape()).toEqual({ col: "uuid", del: "n" });
      expect((await client.query("SELECT created_by_user_id FROM api_keys WHERE id = $1", [key])).rows[0].created_by_user_id).toBe(user);
      await client.query("DELETE FROM users WHERE id = $1", [user]);
      expect((await client.query("SELECT created_by_user_id FROM api_keys WHERE id = $1", [key])).rows[0].created_by_user_id).toBeNull();
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await pool.end();
    }
  });
});

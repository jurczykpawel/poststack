import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

const NAME = "deliveries_workspace_status_scheduled_idx";

describe("Queue section index reconciliation", () => {
  it("creates the index on an existing database and repeated runs keep it", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const client = await pool.connect();
    const definition = async () => (await client.query("SELECT indexdef FROM pg_indexes WHERE indexname=$1", [NAME])).rows[0]?.indexdef as string | undefined;
    try {
      await client.query("BEGIN");
      expect(await definition()).toContain("(workspace_id, status, scheduled_at, id)");
      await client.query(`DROP INDEX ${NAME}`);
      expect(await definition()).toBeUndefined();
      const delta = await readFile(new URL("./0019_queue_section_index.sql", import.meta.url), "utf8");
      await client.query(delta);
      await client.query(delta);
      expect(await definition()).toContain("(workspace_id, status, scheduled_at, id)");
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await pool.end();
    }
  });
});

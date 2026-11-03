import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

describe("Message failure_reason reconciliation", () => {
  it("adds the column on an existing database and repeated runs keep it", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const client = await pool.connect();
    const column = async () =>
      (await client.query("SELECT data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'messages' AND column_name = 'failure_reason'")).rows[0]?.data_type as string | undefined;
    try {
      await client.query("BEGIN");
      expect(await column()).toBe("text");
      await client.query('ALTER TABLE "messages" DROP COLUMN "failure_reason"');
      expect(await column()).toBeUndefined();
      const delta = await readFile(new URL("./0020_message_failure_reason.sql", import.meta.url), "utf8");
      await client.query(delta);
      await client.query(delta);
      expect(await column()).toBe("text");
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await pool.end();
    }
  });
});

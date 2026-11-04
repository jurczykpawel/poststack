import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

describe("Delivery sent_at reconciliation", () => {
  it("adds the column on an existing database and repeated runs keep it", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const client = await pool.connect();
    const column = async () =>
      (await client.query("SELECT data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'deliveries' AND column_name = 'sent_at'")).rows[0]?.data_type as string | undefined;
    try {
      await client.query("BEGIN");
      expect(await column()).toBe("timestamp without time zone");
      await client.query('ALTER TABLE "deliveries" DROP COLUMN "sent_at"');
      expect(await column()).toBeUndefined();
      const delta = await readFile(new URL("./0023_delivery_sent_at.sql", import.meta.url), "utf8");
      await client.query(delta);
      await client.query(delta);
      expect(await column()).toBe("timestamp without time zone");
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await pool.end();
    }
  });
});

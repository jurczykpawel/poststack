import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { expect, it } from "vitest";

it("reconciles the Telegram publish target repeatedly and preserves a saved value", async () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [ws] } = await client.query("INSERT INTO workspaces(name,slug) VALUES('TG target migration','tg-target-migration') RETURNING id");
    await client.query("INSERT INTO channels(workspace_id,platform,platform_id,token_encrypted,webhook_secret) VALUES($1,'telegram','tg-target-migration','unused','test')", [ws.id]);
    await client.query("ALTER TABLE channels DROP COLUMN publish_target");
    const delta = await readFile(new URL("./0029_telegram_publish_target.sql", import.meta.url), "utf8");
    await client.query(delta);
    expect((await client.query("SELECT publish_target FROM channels WHERE workspace_id=$1", [ws.id])).rows[0].publish_target).toBeNull();
    await client.query("UPDATE channels SET publish_target='@acme_news' WHERE workspace_id=$1", [ws.id]);
    await client.query(delta);
    expect((await client.query("SELECT publish_target FROM channels WHERE workspace_id=$1", [ws.id])).rows[0].publish_target).toBe("@acme_news");
  } finally { await client.query("ROLLBACK"); client.release(); await pool.end(); }
});

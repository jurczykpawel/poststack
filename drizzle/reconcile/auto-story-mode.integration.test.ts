import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { expect, it } from "vitest";

it("reconciles Story modes repeatedly and preserves configured values", async () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [ws] } = await client.query("INSERT INTO workspaces(name,slug) VALUES('Story migration','story-mode-migration') RETURNING id");
    await client.query("INSERT INTO channels(workspace_id,platform,platform_id,token_encrypted,webhook_secret) VALUES($1,'facebook','story-migration','unused','test')", [ws.id]);
    await client.query('ALTER TABLE channels DROP COLUMN default_auto_story_mode; ALTER TABLE posts DROP COLUMN auto_story_mode; DROP TYPE auto_story_mode');
    const delta = await readFile(new URL("./0028_auto_story_mode.sql", import.meta.url), "utf8");
    await client.query(delta);
    expect((await client.query("SELECT default_auto_story_mode FROM channels WHERE workspace_id=$1", [ws.id])).rows[0].default_auto_story_mode).toBe("card");
    await client.query("UPDATE channels SET default_auto_story_mode='media' WHERE workspace_id=$1", [ws.id]);
    await client.query(delta);
    expect((await client.query("SELECT default_auto_story_mode FROM channels WHERE workspace_id=$1", [ws.id])).rows[0].default_auto_story_mode).toBe("media");
  } finally { await client.query("ROLLBACK"); client.release(); await pool.end(); }
});

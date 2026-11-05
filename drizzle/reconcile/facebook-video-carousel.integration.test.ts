import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { expect, it } from "vitest";

it("reconciles video carousel state on an existing database without changing channel values", async () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [workspace] } = await client.query("INSERT INTO workspaces(name,slug) VALUES('Migration test','video-carousel-migration') RETURNING id");
    await client.query("INSERT INTO channels(workspace_id,platform,platform_id,token_encrypted,webhook_secret) VALUES($1,'facebook','migration-video-page','unused','test')", [workspace.id]);
    await client.query('ALTER TABLE "channels" DROP COLUMN "video_carousel"; DROP TYPE "video_carousel_state"');
    const delta = await readFile(new URL("./0024_facebook_video_carousel.sql", import.meta.url), "utf8");
    await client.query(delta);
    const before = (await client.query("SELECT id, video_carousel FROM channels WHERE workspace_id=$1 ORDER BY id", [workspace.id])).rows;
    expect(before).toHaveLength(1);
    expect(before[0].video_carousel).toBe("unknown");
    await client.query("UPDATE channels SET video_carousel='available' WHERE workspace_id=$1", [workspace.id]);
    await client.query(delta);
    expect((await client.query("SELECT id, video_carousel FROM channels WHERE workspace_id=$1 ORDER BY id", [workspace.id])).rows).toEqual(before.map(r => ({ ...r, video_carousel: "available" })));
    const values = (await client.query("SELECT enumlabel FROM pg_enum WHERE enumtypid='video_carousel_state'::regtype ORDER BY enumsortorder")).rows.map(r => r.enumlabel);
    expect(values).toEqual(["unknown", "unavailable", "available"]);
  } finally {
    await client.query("ROLLBACK"); client.release(); await pool.end();
  }
});

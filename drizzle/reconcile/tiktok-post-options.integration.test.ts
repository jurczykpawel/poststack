import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

describe("TikTok post options reconciliation", () => {
  it("adds fields to an existing post and preserves choices on repeated runs", async () => {
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const workspace = randomUUID();
      const post = randomUUID();
      await client.query("INSERT INTO workspaces(id, name, slug) VALUES ($1, 'Migration test', $2)", [workspace, workspace]);
      await client.query("INSERT INTO posts(id, workspace_id, platform, description) VALUES ($1, $2, 'tiktok', 'Keep this caption')", [post, workspace]);
      await client.query(`ALTER TABLE posts DROP COLUMN tiktok_publish_mode, DROP COLUMN tiktok_privacy_level,
        DROP COLUMN tiktok_disable_comment, DROP COLUMN tiktok_disable_duet, DROP COLUMN tiktok_disable_stitch,
        DROP COLUMN tiktok_brand_content_toggle, DROP COLUMN tiktok_brand_organic_toggle, DROP COLUMN tiktok_cover_timestamp_ms`);
      await client.query("DROP TYPE tiktok_publish_mode, tiktok_privacy_level");
      const delta = await readFile(new URL("./0008_tiktok_post_options.sql", import.meta.url), "utf8");
      await client.query(delta);
      const before = await client.query("SELECT description, tiktok_privacy_level FROM posts WHERE id=$1 AND workspace_id=$2", [post, workspace]);
      expect(before.rows).toEqual([{ description: "Keep this caption", tiktok_privacy_level: null }]);
      await client.query("UPDATE posts SET tiktok_publish_mode='direct', tiktok_privacy_level='PUBLIC_TO_EVERYONE', tiktok_disable_comment=false WHERE id=$1 AND workspace_id=$2", [post, workspace]);
      await client.query(delta);
      await client.query(delta);
      const after = await client.query("SELECT description, tiktok_publish_mode, tiktok_privacy_level, tiktok_disable_comment FROM posts WHERE id=$1 AND workspace_id=$2", [post, workspace]);
      expect(after.rows).toEqual([{ description: "Keep this caption", tiktok_publish_mode: "direct", tiktok_privacy_level: "PUBLIC_TO_EVERYONE", tiktok_disable_comment: false }]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await pool.end();
    }
  });
});

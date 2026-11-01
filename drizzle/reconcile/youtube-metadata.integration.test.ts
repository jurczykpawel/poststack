import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

describe("YouTube chapters and metadata reconciliation", () => {
  it("adds columns to an existing post and preserves choices on repeated runs", async () => {
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const workspace = randomUUID();
      const post = randomUUID();
      await client.query("INSERT INTO workspaces(id, name, slug) VALUES ($1, 'Migration test', $2)", [workspace, workspace]);
      await client.query("INSERT INTO posts(id, workspace_id, platform, description) VALUES ($1, $2, 'youtube', 'Keep this caption')", [post, workspace]);
      await client.query(`ALTER TABLE posts DROP COLUMN youtube_chapters, DROP COLUMN youtube_license, DROP COLUMN youtube_embeddable,
        DROP COLUMN youtube_public_stats_viewable, DROP COLUMN youtube_notify_subscribers, DROP COLUMN youtube_default_language,
        DROP COLUMN youtube_recording_date, DROP COLUMN youtube_localizations`);
      await client.query("DROP TYPE youtube_license");
      const delta = await readFile(new URL("./0017_youtube_chapters_and_metadata.sql", import.meta.url), "utf8");
      await client.query(delta);
      await client.query("UPDATE posts SET youtube_license='creativeCommon', youtube_chapters='[{\"start\":0,\"title\":\"A\"}]' WHERE id=$1 AND workspace_id=$2", [post, workspace]);
      await client.query(delta);
      await client.query(delta);
      const after = await client.query("SELECT description, youtube_license, youtube_chapters, youtube_embeddable FROM posts WHERE id=$1 AND workspace_id=$2", [post, workspace]);
      expect(after.rows).toEqual([{ description: "Keep this caption", youtube_license: "creativeCommon", youtube_chapters: [{ start: 0, title: "A" }], youtube_embeddable: null }]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await pool.end();
    }
  });
});

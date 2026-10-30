import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import * as schema from "./schema";

it("stores and returns a 4 GiB media size as a JavaScript number", async () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const db = drizzle(pool, { schema });
  const workspace = randomUUID();
  try {
    await db.insert(schema.workspaces).values({ id: workspace, name: "Large media", slug: workspace });
    const [media] = await db.insert(schema.media).values({ workspace_id: workspace, checksum: "large", storage_key: "large", url: "https://cdn.example/large.mp4", kind: "video", size: 4 * 1024 ** 3 }).returning();
    expect(media!.size).toBe(4294967296);
    const row = await db.query.media.findFirst({ where: eq(schema.media.workspace_id, workspace) });
    expect(row!.size).toBe(4294967296);
  } finally {
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspace));
    await pool.end();
  }
});

it("reconciles an integer media size repeatedly while preserving existing records", async () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const workspace = randomUUID(), media = randomUUID();
    await client.query("INSERT INTO workspaces(id,name,slug) VALUES ($1,'Migration test',$2)", [workspace, workspace]);
    await client.query("INSERT INTO media(id,workspace_id,checksum,storage_key,url,kind,size) VALUES ($1,$2,'small','small','https://cdn.example/small.mp4','video',123)", [media, workspace]);
    await client.query('ALTER TABLE media ALTER COLUMN size TYPE integer USING size::integer');
    const delta = await readFile(new URL("../../drizzle/reconcile/0015_media_size_bigint.sql", import.meta.url), "utf8");
    await client.query(delta);
    await client.query(delta);
    expect((await client.query("SELECT size::text FROM media WHERE id=$1 AND workspace_id=$2", [media, workspace])).rows).toEqual([{ size: "123" }]);
    await client.query("UPDATE media SET size=4294967296 WHERE id=$1 AND workspace_id=$2", [media, workspace]);
    await client.query(delta);
    expect((await client.query("SELECT size::text FROM media WHERE id=$1 AND workspace_id=$2", [media, workspace])).rows).toEqual([{ size: "4294967296" }]);
  } finally {
    await client.query("ROLLBACK"); client.release(); await pool.end();
  }
});

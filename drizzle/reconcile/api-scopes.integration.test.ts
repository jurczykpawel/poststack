import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { expect, it } from "vitest";

const oldScopes = [
  "channels:read", "channels:write", "conversations:read", "conversations:write",
  "contacts:read", "contacts:write", "rules:read", "rules:write",
  "sequences:read", "sequences:write", "tags:read", "tags:write",
  "settings:read", "settings:write", "sources:read", "sources:write",
  "webhooks:read", "webhooks:write", "stats:read",
];
const newScopes = ["brands:read", "brands:write", "content:read", "content:write", "posts:read", "posts:write", "media:write"];

it("extends only complete explicit legacy permissions and stays stable on repeated runs", async () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const workspace = randomUUID();
    await client.query("INSERT INTO workspaces(id, name, slug) VALUES ($1::uuid, 'Scope migration', $1::text)", [workspace]);
    const lists = [oldScopes, [...oldScopes, "brands:read", "custom:read"], [...oldScopes, ...newScopes], [], null,
      ...oldScopes.map((missing) => oldScopes.filter((scope) => scope !== missing))];
    const ids = [];
    for (const scopes of lists) {
      const id = randomUUID();
      ids.push(id);
      await client.query("INSERT INTO api_keys(id, workspace_id, name, key_hash, key_prefix, scopes) VALUES ($1::uuid, $2, 'Migration key', $1::text, 'sk_live_test', $3)", [id, workspace, scopes]);
    }
    const delta = await readFile(new URL("./0014_api_key_publishing_scopes.sql", import.meta.url), "utf8");
    await client.query(delta);
    const read = async () => (await client.query("SELECT id, scopes FROM api_keys WHERE workspace_id=$1 ORDER BY id", [workspace])).rows;
    const once = await read();
    for (const [index, id] of ids.entries()) {
      const scopes = once.find((row) => row.id === id).scopes;
      if (index < 3) {
        expect([...scopes].sort()).toEqual([...new Set([...lists[index]!, ...newScopes])].sort());
        expect(scopes).toHaveLength(new Set(scopes).size);
      } else expect(scopes).toEqual(lists[index]);
    }
    await client.query(delta);
    expect(await read()).toEqual(once);
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
});

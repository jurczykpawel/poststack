import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { expect, it } from "vitest";

it("reconciles the MCP OAuth tables repeatedly, keeps data, and cascades a grant to its tokens", async () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const client = await pool.connect();
  const shape = async () => (await client.query(`SELECT
    (SELECT count(*)::int FROM information_schema.tables WHERE table_schema = current_schema() AND table_name IN ('oauth_clients','oauth_grants')) AS tables,
    (SELECT data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'api_keys' AND column_name = 'oauth_grant_id') AS col,
    (SELECT string_agg(conname || ':' || confdeltype::text, ',' ORDER BY conname) FROM pg_constraint WHERE conname LIKE 'oauth_grants_%_fkey' OR conname = 'api_keys_oauth_grant_id_fkey') AS fks`)).rows[0];
  const expected = { tables: 2, col: "uuid", fks: "api_keys_oauth_grant_id_fkey:c,oauth_grants_client_id_fkey:c,oauth_grants_user_id_fkey:c,oauth_grants_workspace_id_fkey:c" };
  try {
    await client.query("BEGIN");
    expect(await shape()).toEqual(expected); // fresh migrate already has it (folded into 0006)
    await client.query('ALTER TABLE "api_keys" DROP COLUMN "oauth_grant_id"; DROP TABLE "oauth_refresh_tokens"; DROP TABLE "oauth_grants"; DROP TABLE "oauth_clients"; DROP TYPE "oauth_grant_status"');
    const delta = await readFile(new URL("./0030_mcp_oauth.sql", import.meta.url), "utf8");
    const historyDelta = await readFile(new URL("./0031_oauth_refresh_history.sql", import.meta.url), "utf8");
    await client.query(delta);
    await client.query(historyDelta);
    expect(await shape()).toEqual(expected);

    const user = randomUUID(), ws = randomUUID(), grant = randomUUID();
    await client.query("INSERT INTO users(id, email) VALUES ($1, $2)", [user, `oauth-${user}@test.local`]);
    await client.query("INSERT INTO workspaces(id, name, slug) VALUES ($1::uuid, 'OAuth', $1::text)", [ws]);
    await client.query("INSERT INTO oauth_clients(id, name, redirect_uris) VALUES ('mcp_reconcile', 'C', ARRAY['https://claude.ai/api/mcp/auth_callback'])");
    await client.query(`INSERT INTO oauth_grants(id, client_id, workspace_id, user_id, scopes, status, code_hash, code_challenge, redirect_uri, code_expires_at)
      VALUES ($1::uuid, 'mcp_reconcile', $2, $3, ARRAY['posts:read'], 'active', $1::text, 'x', 'https://claude.ai/api/mcp/auth_callback', now())`, [grant, ws, user]);
    await client.query("INSERT INTO api_keys(workspace_id, name, key_hash, key_prefix, oauth_grant_id) VALUES ($1, 't', $2::text, 'sk_live_t', $2::uuid)", [ws, grant]);
    await client.query("INSERT INTO oauth_refresh_tokens(hash, grant_id) VALUES ('used-refresh', $1)", [grant]);
    await client.query(delta); // second run: nothing breaks, data stays
    await client.query(historyDelta);
    expect((await client.query("SELECT count(*)::int AS n FROM oauth_refresh_tokens WHERE grant_id = $1", [grant])).rows[0].n).toBe(1);
    expect(await shape()).toEqual(expected);
    expect((await client.query("SELECT count(*)::int AS n FROM api_keys WHERE oauth_grant_id = $1", [grant])).rows[0].n).toBe(1);
    await client.query("DELETE FROM oauth_clients WHERE id = 'mcp_reconcile'");
    expect((await client.query("SELECT count(*)::int AS n FROM oauth_refresh_tokens WHERE grant_id = $1", [grant])).rows[0].n).toBe(0);
    expect((await client.query("SELECT count(*)::int AS n FROM api_keys WHERE workspace_id = $1", [ws])).rows[0].n).toBe(0);
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
});

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { getTableConfig } from "drizzle-orm/pg-core";
import { Pool, type PoolClient } from "pg";
import { expect, it } from "vitest";
import { insightConnections, insightObservations } from "@/db/schema";

const exec = promisify(execFile);
const folded = "0006_youtube_options_and_ai_disclosure.sql";
const marker = "\n--> statement-breakpoint\n-- Shared insights storage\n";

function migrate(url: string, cwd = process.cwd()) {
  return exec("bun", [resolve("scripts/migrate.ts")], {
    cwd, env: { ...process.env, DATABASE_URL: url }, timeout: 60_000,
  });
}

async function catalog(client: PoolClient) {
  return (await client.query(`SELECT * FROM (SELECT 'column' AS kind, table_name AS name,
      jsonb_build_array(column_name,udt_name,is_nullable,column_default) AS definition
    FROM information_schema.columns WHERE table_schema='public'
    UNION ALL SELECT 'constraint', c.relname, jsonb_build_array(conname,pg_get_constraintdef(p.oid))
    FROM pg_constraint p JOIN pg_class c ON c.oid=p.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public'
    UNION ALL SELECT 'index', tablename, jsonb_build_array(indexname,indexdef)
    FROM pg_indexes WHERE schemaname='public'
    UNION ALL SELECT 'enum',t.typname,jsonb_agg(e.enumlabel ORDER BY e.enumsortorder)
    FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid JOIN pg_namespace n ON n.oid=t.typnamespace
    WHERE n.nspname='public' GROUP BY t.typname) entries ORDER BY kind,name,definition::text`)).rows;
}

it("freshAndExistingDeploymentAgree", async () => {
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const legacy = await mkdtemp(join(tmpdir(), "poststack-insights-legacy-"));
  const names: string[] = [];
  const catalogs: unknown[] = [];
  try {
    await cp("drizzle", join(legacy, "drizzle"), { recursive: true });
    const original = await readFile(join(legacy, "drizzle", folded), "utf8");
    await writeFile(join(legacy, "drizzle", folded), original.split(marker)[0]);
    await rm(join(legacy, "drizzle/reconcile/0026_insights.sql"), { force: true });
    for (const mode of ["fresh", "existing", "partial"]) {
      const name = `insights_${randomUUID().replaceAll("-", "")}`;
      names.push(name);
      await admin.query(`CREATE DATABASE "${name}"`);
      const url = new URL(process.env.TEST_DATABASE_URL!); url.pathname = `/${name}`;
      const pool = new Pool({ connectionString: url.toString() });
      const client = await pool.connect();
      try {
        if (mode !== "fresh") await migrate(url.toString(), legacy);
        else await migrate(url.toString());
        const workspace = randomUUID(); const other = randomUUID(); const channel = randomUUID();
        await client.query("INSERT INTO workspaces(id,name,slug) VALUES($1,'Insights','kept'),($2,'Other','other')", [workspace, other]);
        await client.query(`INSERT INTO channels(id,workspace_id,platform,platform_id,token_encrypted,webhook_secret)
          VALUES($1,$2,'facebook','storage-fixture','unused','unused')`, [channel, workspace]);
        if (mode === "partial") {
          const delta = await readFile(resolve("drizzle/reconcile/0026_insights.sql"), "utf8");
          // A previous startup reached the connection table, but not its foreign keys or indexes.
          await client.query(delta.split('--> statement-breakpoint').slice(0, 9).join(';'));
        }
        if (mode === "existing") await Promise.all([migrate(url.toString()), migrate(url.toString())]);
        else await migrate(url.toString());
        await migrate(url.toString());
        expect((await client.query("SELECT to_regclass('public.insight_observations') AS name")).rows[0].name).toBe("insight_observations");
        // The ORM exports describe the deployed columns and preserve decimal values.
        for (const table of [insightConnections, insightObservations]) {
          const config = getTableConfig(table);
          const actual = await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1", [config.name]);
          expect(actual.rows.map(row => row.column_name).sort()).toEqual(config.columns.map(column => column.name).sort());
        }
        await client.query("INSERT INTO insight_connections(workspace_id,channel_id,platform) VALUES($1,$2,'facebook')", [workspace, channel]);
        const connection = (await client.query("SELECT * FROM insight_connections WHERE workspace_id=$1 AND channel_id=$2", [workspace, channel])).rows[0];
        expect(connection).toMatchObject({ collection_mode: "off", access_state: "unknown", reason: "none", failure_count: 0, checkpoint: { version: 1 }, usage_budget: { version: 1, requestTimes: [], nextSafeAt: null } });
        const insert = `INSERT INTO insight_observations(workspace_id,channel_id,platform,metric_key,level,subject_key,grain,period,metric_type,
          window_start,window_end,snapshot_day,fetched_at,boundary_basis,scalar,response_state,transport,api_version,definition_version,coverage_basis,query_key)
          VALUES($1,$2,$3,$4,'account','account','day','day','time_series','2026-11-04T08:00Z','2026-11-05T08:00Z',
          '2026-11-05',now(),'provider','9007199254740993.125','available','test','v1','1','provider',$5)`;
        const args = [workspace, channel, "facebook", "page_views", "a".repeat(64)];
        await client.query(insert, args);
        await expect(client.query(insert, args)).rejects.toMatchObject({ code: "23505" });
        await expect(client.query(insert, [other, channel, "facebook", "page_views", "b".repeat(64)])).rejects.toMatchObject({ code: "23503" });
        await expect(client.query(insert, [workspace, channel, "instagram", "page_views", "b".repeat(64)])).rejects.toMatchObject({ code: "23503" });
        await expect(client.query("UPDATE insight_connections SET platform='instagram' WHERE workspace_id=$1 AND channel_id=$2", [workspace, channel])).rejects.toMatchObject({ code: "23503" });
        const db = drizzle(client);
        const stored = await db.select({scalar: insightObservations.scalar}).from(insightObservations).where(and(eq(insightObservations.workspace_id, workspace), eq(insightObservations.channel_id,channel)));
        expect(stored[0].scalar).toBe("9007199254740993.125");
        for (const assignment of ["scalar=-1", "scalar='NaN'", "scalar='Infinity'", "scalar=NULL", "response_state='not_available'", "window_end=window_start", "metric_key=repeat('x',129)", "query_key='short'", "dimensions='[]'", "query_params='{\"key\":3}'"]) {
          await expect(client.query(`UPDATE insight_observations SET ${assignment} WHERE workspace_id=$1`, [workspace])).rejects.toMatchObject({ code: "23514" });
        }
        await client.query("UPDATE insight_observations SET scalar=0 WHERE workspace_id=$1", [workspace]);
        await client.query("UPDATE insight_observations SET scalar=NULL,response_state='not_available' WHERE workspace_id=$1", [workspace]);
        for (const assignment of ["failure_count=-1", "checkpoint='{\"version\":2}'", "checkpoint='[]'", "usage_budget='{\"version\":1,\"requestTimes\":[],\"nextSafeAt\":null,\"extra\":true}'", "ig_grants='{\"version\":1,\"names\":[3],\"checkedAt\":null,\"revision\":null}'", "checkpoint=jsonb_build_object('version',1,'cursor',repeat('a',8200))", "claim_token=gen_random_uuid()"] ) {
          await expect(client.query(`UPDATE insight_connections SET ${assignment} WHERE workspace_id=$1`, [workspace])).rejects.toMatchObject({ code: "23514" });
        }
        const requests = JSON.stringify({ version: 1, requestTimes: Array(121).fill("2026-11-08T12:00:00Z"), nextSafeAt: null });
        await expect(client.query("UPDATE insight_connections SET usage_budget=$1 WHERE workspace_id=$2", [requests,workspace])).rejects.toMatchObject({code:"23514"});
        const grants = JSON.stringify({version:1,names:["x".repeat(129)],checkedAt:null,revision:null});
        await expect(client.query("UPDATE insight_connections SET fb_grants=$1 WHERE workspace_id=$2", [grants,workspace])).rejects.toMatchObject({code:"23514"});
        const tooManyGrants = JSON.stringify({version:1,names:Array(65).fill("read_insights"),checkedAt:null,revision:null});
        await expect(client.query("UPDATE insight_connections SET ig_grants=$1 WHERE workspace_id=$2", [tooManyGrants,workspace])).rejects.toMatchObject({code:"23514"});
        const tooManyDimensions = Object.fromEntries(Array.from({length:33}, (_,i) => [`dimension_${i}`,"value"]));
        await expect(client.query("UPDATE insight_observations SET dimensions=$1 WHERE workspace_id=$2", [JSON.stringify(tooManyDimensions),workspace])).rejects.toMatchObject({code:"23514"});
        const budget = JSON.stringify({version:1,requestTimes:Array(120).fill("2026-11-08T12:00:00Z"),nextSafeAt:"2026-11-09T12:00:00Z",usagePercent:83.7});
        const evidence = JSON.stringify({version:1,names:["read_insights"],checkedAt:"2026-11-08T12:00:00Z",revision:"stored-revision"});
        await client.query(`UPDATE insight_connections SET collection_mode='on',transport='test',credential_revision='stored-revision',
          budget_key='shared-budget',usage_budget=$1,fb_grants=$2,checkpoint='{"version":1,"from":"2026-09-01","to":"2026-11-01","cursor":"next-window"}',
          claim_token=gen_random_uuid(),claim_until='2026-11-08T12:15:00Z',backoff_until='2026-11-09T12:00:00Z',failure_count=2
          WHERE workspace_id=$3 AND channel_id=$4`, [budget,evidence,workspace,channel]);
        await client.query("UPDATE insight_observations SET provider_day='2026-11-04' WHERE workspace_id=$1", [workspace]);
        const savedConnection = (await client.query("SELECT * FROM insight_connections WHERE workspace_id=$1", [workspace])).rows;
        const savedObservation = (await client.query("SELECT * FROM insight_observations WHERE workspace_id=$1", [workspace])).rows;
        await migrate(url.toString());
        await migrate(url.toString());
        expect((await client.query("SELECT * FROM insight_connections WHERE workspace_id=$1", [workspace])).rows).toEqual(savedConnection);
        expect((await client.query("SELECT * FROM insight_observations WHERE workspace_id=$1", [workspace])).rows).toEqual(savedObservation);
        // Record the planner choice and timings on the small fixture.
        const read = await client.query("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM insight_observations WHERE workspace_id=$1 AND channel_id=$2 AND window_start >= '2026-11-01'", [workspace,channel]);
        const prune = await client.query("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) DELETE FROM insight_observations WHERE workspace_id=$1 AND grain='range' AND snapshot_day < '2026-11-01'", [workspace]);
        expect(JSON.stringify(read.rows)).toContain("Execution Time");
        expect(JSON.stringify(prune.rows)).toContain("Execution Time");
        console.info(`insights migration ${mode} read/prune plans`, JSON.stringify({read:read.rows,prune:prune.rows}));
        catalogs.push(await catalog(client));
        expect((await client.query("SELECT name FROM workspaces WHERE id=$1", [workspace])).rows[0].name).toBe("Insights");
        await client.query("DELETE FROM channels WHERE workspace_id=$1 AND id=$2", [workspace,channel]);
        expect((await client.query("SELECT count(*) FROM insight_connections WHERE workspace_id=$1", [workspace])).rows[0].count).toBe("0");
        expect((await client.query("SELECT count(*) FROM insight_observations WHERE workspace_id=$1", [workspace])).rows[0].count).toBe("0");
        await client.query(`INSERT INTO channels(id,workspace_id,platform,platform_id,token_encrypted,webhook_secret) VALUES($1,$2,'facebook','cascade','unused','unused')`, [channel, workspace]);
        await client.query("INSERT INTO insight_connections(workspace_id,channel_id,platform) VALUES($1,$2,'facebook')", [workspace,channel]);
        await client.query(insert,args);
        await client.query("DELETE FROM workspaces WHERE id=$1", [workspace]);
        expect((await client.query("SELECT count(*) FROM insight_observations WHERE workspace_id=$1", [workspace])).rows[0].count).toBe("0");
        expect((await client.query("SELECT count(*) FROM insight_connections WHERE workspace_id=$1", [workspace])).rows[0].count).toBe("0");
      } finally { client.release(); await pool.end(); }
    }
    expect(catalogs[1]).toEqual(catalogs[0]);
    expect(catalogs[2]).toEqual(catalogs[0]);
  } finally {
    for (const name of names) await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end(); await rm(legacy, {recursive:true,force:true});
  }
}, 120_000);

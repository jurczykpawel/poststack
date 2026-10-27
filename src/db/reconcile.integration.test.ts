import { execFile } from "node:child_process";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTableConfig } from "drizzle-orm/pg-core";
import { channels, workspaces, pendingApprovals, webhookEndpoints, aiGenerationLogs } from "./schema";

const exec = promisify(execFile);
const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
let pool: Pool;
let databaseUrl: string;
let databaseName: string;

function runMigration(cwd = process.cwd()) {
  return exec("bun", [resolve("scripts/migrate.ts")], {
    cwd,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    timeout: 20_000,
  });
}

async function columns() {
  return (await pool.query(`SELECT table_name, column_name, udt_name, is_nullable, column_default
    FROM information_schema.columns WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position`)).rows;
}

beforeEach(async () => {
  databaseName = `reconcile_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  const url = new URL(process.env.TEST_DATABASE_URL!);
  url.pathname = `/${databaseName}`;
  databaseUrl = url.toString();
  pool = new Pool({ connectionString: databaseUrl });
  await runMigration();
});

afterEach(async () => {
  await pool?.end();
  if (databaseName) await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
});

afterAll(async () => { await admin.end(); });

describe("startup schema reconciliation", () => {
  it("matches Drizzle columns on a fresh database and logs each reconciliation", async () => {
    const actual = await columns();
    for (const table of [channels, workspaces, pendingApprovals, webhookEndpoints, aiGenerationLogs]) {
      const config = getTableConfig(table);
      expect(actual.filter((c) => c.table_name === config.name).map((c) => c.column_name).sort())
        .toEqual(config.columns.map((c) => c.name).sort());
    }
    const result = await runMigration();
    expect(result.stdout.match(/\[migrate\] reconcile .* ok/g)).toHaveLength(7);
  });

  it("restores a column missing from an already migrated database", async () => {
    await pool.query('ALTER TABLE channels DROP COLUMN ai_draft_dm_enabled');
    await runMigration();
    const column = (await columns()).find((c) => c.table_name === "channels" && c.column_name === "ai_draft_dm_enabled");
    expect(column).toMatchObject({ udt_name: "bool", is_nullable: "NO", column_default: "false" });
  });

  it("leaves the schema and saved configuration unchanged on repeated startups", async () => {
    await pool.query(`INSERT INTO workspaces (name, slug, ai_draft_prompt_dm, ai_draft_prompt_public)
      VALUES ('Reconcile', 'reconcile', 'Saved DM', 'Saved public')`);
    const before = await columns();
    await runMigration();
    await runMigration();
    expect(await columns()).toEqual(before);
    expect((await pool.query('SELECT ai_draft_prompt_dm, ai_draft_prompt_public FROM workspaces')).rows)
      .toEqual([{ ai_draft_prompt_dm: "Saved DM", ai_draft_prompt_public: "Saved public" }]);
  });

  it("preserves enabled surfaces from legacy channel settings", async () => {
    await pool.query(`INSERT INTO workspaces (id, name, slug)
      VALUES ('ffffffff-0000-0000-0000-0000000000f9', 'Legacy', 'legacy')`);
    await pool.query(`ALTER TABLE channels DROP COLUMN ai_draft_dm_enabled;
      ALTER TABLE channels DROP COLUMN ai_draft_public_enabled;
      CREATE TYPE ai_draft_target AS ENUM ('dm', 'public', 'both');
      ALTER TABLE channels ADD COLUMN ai_draft_enabled boolean NOT NULL DEFAULT false;
      ALTER TABLE channels ADD COLUMN ai_draft_target ai_draft_target NOT NULL DEFAULT 'dm'`);
    await pool.query(`INSERT INTO channels
      (workspace_id, platform, platform_id, token_encrypted, webhook_secret, ai_draft_enabled, ai_draft_target)
      VALUES ('ffffffff-0000-0000-0000-0000000000f9', 'facebook', 'legacy', 'test', 'test', true, 'public')`);
    await runMigration();
    await runMigration();
    expect((await pool.query('SELECT ai_draft_dm_enabled, ai_draft_public_enabled FROM channels')).rows)
      .toEqual([{ ai_draft_dm_enabled: false, ai_draft_public_enabled: true }]);
  });

  it("rolls back a failed file, stops subsequent files and exits nonzero", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "poststack-reconcile-"));
    try {
      await cp("drizzle", join(cwd, "drizzle"), { recursive: true });
      await writeFile(join(cwd, "drizzle/reconcile/9998_failure.sql"),
        'ALTER TABLE channels ADD COLUMN reconcile_rollback text; SELECT missing_reconcile_function();');
      await writeFile(join(cwd, "drizzle/reconcile/9999_later.sql"),
        'ALTER TABLE channels ADD COLUMN reconcile_later text;');
      await expect(runMigration(cwd)).rejects.toMatchObject({ code: 1 });
      expect((await columns()).filter((c) => c.column_name.startsWith("reconcile_"))).toEqual([]);
      await runMigration();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("carries a legacy prompt forward to its DM column", async () => {
    await pool.query('ALTER TABLE channels RENAME COLUMN ai_draft_prompt_dm TO ai_draft_prompt');
    await pool.query('ALTER TABLE workspaces RENAME COLUMN ai_draft_prompt_dm TO ai_draft_prompt');
    await pool.query(`INSERT INTO workspaces (name, slug, ai_draft_prompt) VALUES ('Legacy', 'legacy', 'Legacy DM')`);
    await runMigration();
    expect((await pool.query('SELECT ai_draft_prompt_dm FROM workspaces')).rows)
      .toEqual([{ ai_draft_prompt_dm: "Legacy DM" }]);
    expect((await columns()).some((c) => c.column_name === "ai_draft_prompt")).toBe(false);
  });
});

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { inArray, sql } from "drizzle-orm";

// Sender-side contract guard: a real buildEnvelope() output must parse against the strict
// telemetryEnvelopeV1 schema. If a field is added/renamed/dropped/retyped on the sender without
// updating the shared contract, the strict parse throws here and this test fails loudly.

const TEST_DB = process.env.TEST_DATABASE_URL;
const APP_URL = "https://contract-real-domain.example.org";

let db: typeof import("@/lib/db").db;
let schema: typeof import("@/db/schema");
let encryptTokens: typeof import("@/lib/crypto").encryptTokens;
let seedWorkspace: typeof import("../../../tests/helpers/workspace").seedWorkspace;
let buildEnvelope: typeof import("./collect").buildEnvelope;
let telemetryEnvelopeV1: typeof import("./contract").telemetryEnvelopeV1;

let WS = "", CH_IG = "", CH_FB = "";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY = "test-encryption-key-at-least-32-characters-long";
  process.env.JWT_SECRET = "jwt-secret-value-at-least-32-characters-long-xyz";
  process.env.APP_URL = APP_URL;
  process.env.CRON_SECRET = "cron-secret-value-at-least-32-characters-long-xyz";
  ({ db } = await import("@/lib/db"));
  schema = await import("@/db/schema");
  ({ encryptTokens } = await import("@/lib/crypto"));
  ({ seedWorkspace } = await import("../../../tests/helpers/workspace"));
  ({ buildEnvelope } = await import("./collect"));
  ({ telemetryEnvelopeV1 } = await import("./contract"));
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(schema.workspaces).where(inArray(schema.workspaces.id, [WS].filter(Boolean)));
  await db.delete(schema.telemetryState);
  await db.$client.end();
});

beforeEach(async () => {
  if (!TEST_DB) return;
  if (WS) await db.delete(schema.workspaces).where(inArray(schema.workspaces.id, [WS]));
  await db.delete(schema.telemetryState);
  WS = await seedWorkspace(db, schema, { slug: `con-${Math.random().toString(36).slice(2)}` });

  const mk = (platform: "instagram" | "facebook", status: "active" | "needs_reauth") =>
    db.insert(schema.channels).values({
      workspace_id: WS, platform, platform_id: `${platform}-${Math.random()}`,
      connection_mode: "oauth", status,
      token_encrypted: encryptTokens({ access_token: "T" }), webhook_secret: "wh",
    }).returning({ id: schema.channels.id });

  const [ig] = await mk("instagram", "active");
  const [fb] = await mk("facebook", "needs_reauth");
  CH_IG = ig!.id;
  CH_FB = fb!.id;
});

/** Seed a representative slice so the metrics object carries real nested values to assert against. */
async function seedActivity() {
  const received = sql`now() - interval '1 day'`;
  await db.insert(schema.responseMetrics).values([
    { workspace_id: WS, channel_id: CH_IG, platform: "instagram", thread_type: "dm", received_at: received, handled_at: received, handling_ms: 1_000, first_response_ms: 2_000, outcome: "answered" },
    { workspace_id: WS, channel_id: CH_FB, platform: "facebook", thread_type: "comment", received_at: received, handled_at: received, handling_ms: 1_500, first_response_ms: null, outcome: "no_match" },
  ]);
}

describe("telemetry envelope contract (real Postgres)", () => {
  it("a real buildEnvelope() output parses against the strict schema", async () => {
    if (!TEST_DB) return;
    await seedActivity();
    const env = await buildEnvelope(db);
    expect(() => telemetryEnvelopeV1.parse(env)).not.toThrow();
  });

  it("pins the schema_version and representative nested fields", async () => {
    if (!TEST_DB) return;
    await seedActivity();
    const env = await buildEnvelope(db);
    const parsed = telemetryEnvelopeV1.parse(env);

    expect(parsed.schema_version).toBe(1);
    expect(parsed.project).toBe("poststack");
    expect(parsed.deployment.runtime).toBe("bun");
    expect(parsed.deployment.integrations.storage).toBeDefined();
    // Anonymous identity: tier only, no hashes.
    expect(parsed.identity).toEqual({ license_tier: null });
    // report_id is a uuid for receiver dedup.
    expect(parsed.report_id).toMatch(/^[0-9a-f-]{36}$/);
    // Deployment is coarsened (string buckets, no raw fingerprint fields).
    expect(typeof parsed.deployment.cpu_bucket).toBe("string");
    expect(typeof parsed.deployment.mem_bucket).toBe("string");
    expect(parsed.deployment).not.toHaveProperty("mem_total_mb");
    expect(parsed.deployment).not.toHaveProperty("node_env");
    expect(parsed.metrics.channels.total).toBeGreaterThanOrEqual(2);
    expect(parsed.metrics.response_times.window_days).toBe(30);
  });

  it("rejects an envelope with an unexpected top-level field", async () => {
    if (!TEST_DB) return;
    const env = await buildEnvelope(db);
    const drifted = { ...env, surprise_field: true };
    expect(() => telemetryEnvelopeV1.parse(drifted)).toThrow();
  });

  it("rejects a stray identity.domain_hash (strict anonymity guard)", async () => {
    if (!TEST_DB) return;
    const env = await buildEnvelope(db);
    const drifted = { ...env, identity: { ...env.identity, domain_hash: "deadbeef" } };
    expect(telemetryEnvelopeV1.safeParse(drifted).success).toBe(false);
  });
});

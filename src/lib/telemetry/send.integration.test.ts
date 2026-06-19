import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";

// Real Postgres: sendTelemetry() POSTs the envelope (fetch stubbed) and, on a 2xx, records
// last_sent_at on the telemetry_state singleton. The send itself must never throw.

const TEST_DB = process.env.TEST_DATABASE_URL;

let db: typeof import("@/lib/db").db;
let schema: typeof import("@/db/schema");
let sendTelemetry: typeof import("./send").sendTelemetry;

const SINGLETON = "singleton";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY = "test-encryption-key-at-least-32-characters-long";
  process.env.JWT_SECRET = "jwt-secret-value-at-least-32-characters-long-xyz";
  process.env.APP_URL = "https://send-it.example.org";
  process.env.CRON_SECRET = "cron-secret-value-at-least-32-characters-long-xyz";
  // Force telemetry ON (default), with a URL we'll never actually hit (fetch is stubbed).
  process.env.POSTSTACK_TELEMETRY_DISABLED = "false";
  process.env.POSTSTACK_TELEMETRY_ENABLED = "true";
  process.env.TELEMETRY_URL = "https://telemetry.invalid.example/v1/ingest";
  ({ db } = await import("@/lib/db"));
  schema = await import("@/db/schema");
  ({ sendTelemetry } = await import("./send"));
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(schema.telemetryState);
  await db.$client.end();
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.delete(schema.telemetryState);
  vi.restoreAllMocks();
});

describe("sendTelemetry (real Postgres)", () => {
  it("writes last_sent_at on the singleton after a successful POST", async () => {
    if (!TEST_DB) return;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 202 })));

    const before = await db.query.telemetryState.findFirst({ where: eq(schema.telemetryState.id, SINGLETON) });
    expect(before?.last_sent_at ?? null).toBeNull();

    await expect(sendTelemetry(db)).resolves.toBeUndefined();

    const after = await db.query.telemetryState.findFirst({ where: eq(schema.telemetryState.id, SINGLETON) });
    expect(after).toBeTruthy();
    expect(after!.last_sent_at).toBeInstanceOf(Date);
  });

  it("does not write last_sent_at when the endpoint keeps failing (and never throws)", async () => {
    if (!TEST_DB) return;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 503 })));

    await expect(sendTelemetry(db)).resolves.toBeUndefined();

    const after = await db.query.telemetryState.findFirst({ where: eq(schema.telemetryState.id, SINGLETON) });
    // ensureInstanceId (inside buildEnvelope) creates the singleton row, but with a null last_sent_at.
    expect(after?.last_sent_at ?? null).toBeNull();
  });
});

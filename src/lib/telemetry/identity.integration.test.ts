import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";

// Real Postgres: the instance id is persisted once in the telemetry_state singleton and stays
// stable across calls/restarts; concurrent first-calls must not create duplicates. getLicenseIdentity
// returns nulls when no license is configured.

const TEST_DB = process.env.TEST_DATABASE_URL;

let db: typeof import("@/lib/db").db;
let ensureInstanceId: typeof import("./identity").ensureInstanceId;
let getLicenseIdentity: typeof import("./identity").getLicenseIdentity;
let telemetryState: typeof import("@/db/schema").telemetryState;
let instanceLicense: typeof import("@/db/schema").instanceLicense;
let invalidateLicenseCache: typeof import("@/lib/license/gate").invalidateLicenseCache;

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  ({ ensureInstanceId, getLicenseIdentity } = await import("./identity"));
  ({ telemetryState, instanceLicense } = await import("@/db/schema"));
  ({ invalidateLicenseCache } = await import("@/lib/license/gate"));
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.delete(telemetryState);
  // A stored license token would otherwise be resolved by getLicenseIdentity, so clear the
  // singleton (other suites in this serial run may have left one) to assert the no-license path.
  await db.delete(instanceLicense);
  invalidateLicenseCache();
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(telemetryState);
  await db.$client.end();
});

describe("ensureInstanceId (real Postgres)", () => {
  it("creates the row once and returns the same id on a second call", async () => {
    if (!TEST_DB) return;
    const first = await ensureInstanceId(db);
    const second = await ensureInstanceId(db);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).toBe(first);

    const rows = await db.select().from(telemetryState);
    expect(rows).toHaveLength(1);
    expect(rows[0].instance_id).toBe(first);
  });

  it("does not create duplicates under concurrent first-calls", async () => {
    if (!TEST_DB) return;
    const ids = await Promise.all(Array.from({ length: 8 }, () => ensureInstanceId(db)));
    expect(new Set(ids).size).toBe(1);

    const rows = await db.select().from(telemetryState);
    expect(rows).toHaveLength(1);
  });
});

describe("getLicenseIdentity (real Postgres)", () => {
  it("returns nulls when no license is configured", async () => {
    if (!TEST_DB) return;
    const id = await getLicenseIdentity();
    expect(id).toEqual({ licenseHash: null, licenseTier: null });
  });
});

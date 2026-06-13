import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let notifyRealtime: typeof import("@/lib/events").notifyRealtime;
let hub: typeof import("./hub");

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY ??= "test-encryption-key-at-least-32-characters-long";
  process.env.JWT_SECRET ??= "test-secret-at-least-32-characters-long";
  process.env.APP_URL ??= "http://localhost:3000";
  process.env.CRON_SECRET ??= "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  ({ notifyRealtime } = await import("@/lib/events"));
  hub = await import("./hub");
  await hub.startRealtimeListener(TEST_DB);
});

afterAll(async () => {
  if (!TEST_DB) return;
  await hub.stopRealtimeListener();
  await db.$client.end();
});

beforeEach(() => {
  if (!TEST_DB) return;
  hub.__resetHub();
});

const waitFor = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("realtime hub — live LISTEN/NOTIFY path", () => {
  it("a pg_notify('realtime', …) for ws A reaches an A subscriber and not a B subscriber", async () => {
    if (!TEST_DB) return;
    const a: { kind: string; id: string }[] = [];
    const b: { kind: string; id: string }[] = [];
    hub.subscribe("rt-ws-A", (s) => a.push(s));
    hub.subscribe("rt-ws-B", (s) => b.push(s));

    await notifyRealtime(db, "rt-ws-A", "comment", "live-1");
    // NOTIFY delivery is async (Postgres → LISTEN conn → dispatch). Poll briefly.
    for (let i = 0; i < 50 && a.length === 0; i++) await waitFor(20);

    expect(a).toEqual([{ kind: "comment", id: "live-1" }]);
    expect(b).toHaveLength(0); // workspace isolation across the real bus
  });
});

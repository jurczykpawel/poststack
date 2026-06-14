import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let schema: typeof import("@/db/schema");
let encryptTokens: typeof import("@/lib/crypto").encryptTokens;
let createDelivery: typeof import("./service").createDelivery;
let isUniqueViolation: typeof import("@/lib/db").isUniqueViolation;
let seedWorkspace: typeof import("../../../tests/helpers/workspace").seedWorkspace;
let WS = "";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY = "test-encryption-key-at-least-32-characters-long";
  process.env.JWT_SECRET ??= "test-secret-at-least-32-characters-long";
  process.env.APP_URL ??= "http://localhost:3000";
  process.env.CRON_SECRET ??= "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  schema = await import("@/db/schema");
  ({ encryptTokens } = await import("@/lib/crypto"));
  ({ createDelivery } = await import("./service"));
  ({ isUniqueViolation } = await import("@/lib/db"));
  ({ seedWorkspace } = await import("../../../tests/helpers/workspace"));
  WS = await seedWorkspace(db, schema, { slug: `idem-race-${Date.now()}` });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(schema.deliveries).where(eq(schema.deliveries.workspace_id, WS));
  await db.delete(schema.media).where(eq(schema.media.workspace_id, WS));
  await db.delete(schema.channels).where(eq(schema.channels.workspace_id, WS));
  await db.delete(schema.workspaces).where(eq(schema.workspaces.id, WS));
  await db.$client.end();
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.delete(schema.deliveries).where(eq(schema.deliveries.workspace_id, WS));
  await db.delete(schema.media).where(eq(schema.media.workspace_id, WS));
  await db.delete(schema.channels).where(eq(schema.channels.workspace_id, WS));
});

describe("isUniqueViolation", () => {
  it("detects 23505 on the error or its cause", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
    expect(isUniqueViolation({ cause: { code: "23505" } })).toBe(true);
    expect(isUniqueViolation({ code: "23502" })).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});

describe("AUD32 — concurrent same Idempotency-Key", () => {
  it("two concurrent creates with the same key return the same post (no 500)", async () => {
    if (!TEST_DB) return;
    const [c] = await db
      .insert(schema.channels)
      .values({
        workspace_id: WS,
        platform: "tiktok",
        platform_id: `A-${Math.random()}`,
        connection_mode: "manual_token",
        token_encrypted: encryptTokens({ access_token: "t" }),
        webhook_secret: "wh",
      })
      .returning();
    const [m] = await db
      .insert(schema.media)
      .values({ workspace_id: WS, checksum: `c${Math.random()}`, storage_key: "k", url: "https://cdn/x.mp4", kind: "video" })
      .returning();
    const args = {
      channelId: c!.id,
      scheduledAt: new Date().toISOString(),
      request: { format: "video" as const, media: [{ mediaId: m!.id }] },
      idempotencyKey: "race-key",
    };

    const [a, b] = await Promise.all([createDelivery(args, WS), createDelivery(args, WS)]);
    expect(b.id).toBe(a.id);
    const rows = await db.query.deliveries.findMany({
      where: eq(schema.deliveries.idempotency_key, "race-key"),
    });
    expect(rows.length).toBe(1);
  });
});

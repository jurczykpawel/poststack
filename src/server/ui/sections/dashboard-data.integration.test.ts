import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let schema: typeof import("@/db/schema");
let encryptTokens: typeof import("@/lib/crypto").encryptTokens;
let seedWorkspace: typeof import("../../../../tests/helpers/workspace").seedWorkspace;
let dd: typeof import("./dashboard-data");
let WS_A = "";
let WS_B = "";

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
  ({ seedWorkspace } = await import("../../../../tests/helpers/workspace"));
  dd = await import("./dashboard-data");
});

afterAll(async () => {
  if (!TEST_DB) return;
  if (WS_A) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, WS_A));
  if (WS_B) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, WS_B));
  await db.$client.end();
});

beforeEach(async () => {
  if (!TEST_DB) return;
  if (WS_A) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, WS_A));
  if (WS_B) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, WS_B));
  WS_A = await seedWorkspace(db, schema, { slug: `dash-a-${Math.random().toString(36).slice(2)}` });
  WS_B = await seedWorkspace(db, schema, { slug: `dash-b-${Math.random().toString(36).slice(2)}` });
});

async function channel(ws: string, status: "active" | "needs_reauth" | "paused" = "active"): Promise<string> {
  const [c] = await db.insert(schema.channels).values({
    workspace_id: ws, platform: "instagram", platform_id: `acct-${Math.random()}`, display_name: "Chan",
    token_encrypted: encryptTokens({ access_token: "t" }), webhook_secret: "w", status,
  }).returning({ id: schema.channels.id });
  return c!.id;
}

async function delivery(ws: string, chId: string, status: (typeof schema.deliveries.$inferInsert)["status"], at: Date): Promise<void> {
  await db.insert(schema.deliveries).values({
    workspace_id: ws, channel_id: chId, format: "reel", status, payload: {}, scheduled_at: at, run_at: at,
  });
}

describe("dashboard-data gatherAttention", () => {
  it("surfaces needs_reauth channels + recent failures, urgency-sorted, workspace-scoped", async () => {
    if (!TEST_DB) return;
    await channel(WS_A, "needs_reauth");
    const chFail = await channel(WS_A, "active");
    await db.insert(schema.deliveries).values({ workspace_id: WS_A, channel_id: chFail, format: "reel", status: "failed", payload: {}, scheduled_at: new Date(), run_at: new Date(), last_error: "boom", updated_at: new Date() });
    // Another workspace's broken channel must NOT appear.
    await channel(WS_B, "needs_reauth");

    const rows = await dd.gatherAttention(WS_A);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows[0]!.tone).toBe("bad"); // failed delivery ranks first
    expect(rows[0]!.action.variant).toBe("primary");
    // none of WS_A's rows reference a WS_B title
    expect(rows.every((r) => r.title === "Chan")).toBe(true);
  });

  it("returns nothing when all healthy", async () => {
    if (!TEST_DB) return;
    await channel(WS_A, "active");
    expect(await dd.gatherAttention(WS_A)).toHaveLength(0);
  });

  it("sends a needs_reauth channel's Reconnect straight to its OAuth flow, not /channels", async () => {
    if (!TEST_DB) return;
    await db.insert(schema.channels).values({
      workspace_id: WS_A, platform: "facebook", platform_id: `fb-${Math.random()}`, display_name: "FB Page",
      token_encrypted: encryptTokens({ access_token: "t" }), webhook_secret: "w", status: "needs_reauth", connection_mode: "oauth",
    });
    await db.insert(schema.channels).values({
      workspace_id: WS_A, platform: "instagram", platform_id: `ig-${Math.random()}`, display_name: "IG Derived",
      token_encrypted: encryptTokens({ access_token: "t" }), webhook_secret: "w", status: "needs_reauth", connection_mode: "derived",
    });
    const rows = await dd.gatherAttention(WS_A);
    expect(rows.find((r) => r.title === "FB Page")?.action.href).toBe("/api/oauth/facebook");
    expect(rows.find((r) => r.title === "IG Derived")?.action.href).toBe("/sources");
  });
});

describe("dashboard-data upcomingScheduled + recentEvents", () => {
  it("lists future scheduled soonest-first, only this workspace", async () => {
    if (!TEST_DB) return;
    const ch = await channel(WS_A);
    await delivery(WS_A, ch, "scheduled", new Date(Date.now() + 2 * 3600_000));
    await delivery(WS_A, ch, "scheduled", new Date(Date.now() + 1 * 3600_000));
    const chB = await channel(WS_B);
    await delivery(WS_B, chB, "scheduled", new Date(Date.now() + 1 * 3600_000));

    const up = await dd.upcomingScheduled(WS_A, 10);
    expect(up).toHaveLength(2); // not WS_B's
    expect(up[0]!.scheduledAt.getTime()).toBeLessThan(up[1]!.scheduledAt.getTime());
  });

  it("recentEvents returns only this workspace's events newest-first", async () => {
    if (!TEST_DB) return;
    await db.insert(schema.events).values([
      { workspace_id: WS_A, type: "channel.connected", created_at: new Date(Date.now() - 1000) },
      { workspace_id: WS_A, type: "post.published", created_at: new Date() },
      { workspace_id: WS_B, type: "post.failed", created_at: new Date() },
    ]);
    const ev = await dd.recentEvents(WS_A, 10);
    expect(ev).toHaveLength(2);
    expect(ev[0]!.type).toBe("post.published"); // newest first
  });
});

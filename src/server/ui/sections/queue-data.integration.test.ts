import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let schema: typeof import("@/db/schema");
let encryptTokens: typeof import("@/lib/crypto").encryptTokens;
let seedWorkspace: typeof import("../../../../tests/helpers/workspace").seedWorkspace;
let qd: typeof import("./queue-data");
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
  qd = await import("./queue-data");
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
  WS_A = await seedWorkspace(db, schema, { slug: `queue-a-${Math.random().toString(36).slice(2)}` });
  WS_B = await seedWorkspace(db, schema, { slug: `queue-b-${Math.random().toString(36).slice(2)}` });
});

async function channel(ws: string, o: { platform?: string; name?: string } = {}): Promise<string> {
  const [c] = await db.insert(schema.channels).values({
    workspace_id: ws,
    platform: (o.platform ?? "youtube") as (typeof schema.channels.$inferInsert)["platform"],
    platform_id: `acct-${Math.random()}`,
    display_name: o.name ?? null,
    connection_mode: "oauth",
    status: "active",
    token_encrypted: encryptTokens({ access_token: "t" }),
    webhook_secret: "w",
  }).returning({ id: schema.channels.id });
  return c!.id;
}

async function post(ws: string, o: {
  channelId: string;
  status: (typeof schema.deliveries.$inferInsert)["status"];
  format?: string;
  at?: Date;
  lastError?: string;
}): Promise<string> {
  const at = o.at ?? new Date();
  const [p] = await db.insert(schema.deliveries).values({
    workspace_id: ws,
    channel_id: o.channelId,
    format: o.format ?? "reel",
    status: o.status,
    payload: { format: o.format ?? "reel", media: [] },
    scheduled_at: at,
    run_at: at,
    last_error: o.lastError ?? null,
  }).returning({ id: schema.deliveries.id });
  return p!.id;
}

describe("queue-data listQueue", () => {
  it("joins the channel (platform + name) onto each post, workspace-scoped", async () => {
    if (!TEST_DB) return;
    const chId = await channel(WS_A, { platform: "tiktok", name: "WiR" });
    await post(WS_A, { channelId: chId, status: "failed", lastError: "rate limited" });
    // A delivery in WS_B must be invisible to WS_A.
    const chB = await channel(WS_B, { platform: "youtube" });
    await post(WS_B, { channelId: chB, status: "failed" });

    const rows = await qd.listQueue({ workspaceId: WS_A, limit: 50 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.platform).toBe("tiktok");
    expect(rows[0]!.channelName).toBe("WiR");
    expect(rows[0]!.lastError).toBe("rate limited");
  });

  it("orders failures + upcoming first when no status filter (urgency-first)", async () => {
    if (!TEST_DB) return;
    const chId = await channel(WS_A);
    await post(WS_A, { channelId: chId, status: "sent" });
    await post(WS_A, { channelId: chId, status: "failed" });
    await post(WS_A, { channelId: chId, status: "scheduled" });
    const rows = await qd.listQueue({ workspaceId: WS_A, limit: 50 });
    expect(rows[0]!.status).toBe("failed"); // rank 0
    expect(rows.at(-1)!.status).toBe("sent"); // terminal sinks
  });

  it("filters by status + channel", async () => {
    if (!TEST_DB) return;
    const ch1 = await channel(WS_A);
    const ch2 = await channel(WS_A);
    await post(WS_A, { channelId: ch1, status: "failed" });
    await post(WS_A, { channelId: ch2, status: "scheduled" });
    expect(await qd.listQueue({ workspaceId: WS_A, limit: 50, status: "failed" })).toHaveLength(1);
    expect(await qd.listQueue({ workspaceId: WS_A, limit: 50, channelId: ch2 })).toHaveLength(1);
  });
});

describe("queue-data getQueueItem isolation", () => {
  it("returns own item, NEVER another workspace's delivery", async () => {
    if (!TEST_DB) return;
    const chB = await channel(WS_B);
    const idB = await post(WS_B, { channelId: chB, status: "failed" });
    expect(await qd.getQueueItem(WS_B, idB)).toBeDefined();
    expect(await qd.getQueueItem(WS_A, idB)).toBeUndefined(); // cross-workspace read blocked
  });

  it("channelOptions lists only this workspace's channels", async () => {
    if (!TEST_DB) return;
    await channel(WS_A, { name: "A chan" });
    await channel(WS_B, { name: "B chan" });
    const opts = await qd.channelOptions(WS_A);
    expect(opts).toHaveLength(1);
    expect(opts[0]!.label).toBe("A chan");
  });
});

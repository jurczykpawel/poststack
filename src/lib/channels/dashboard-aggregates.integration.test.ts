import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";

// PostStack exposed a dedicated `channelStatusCounts()` for the dashboard. In the unified trunk that
// invariant lives on `listChannels(...).countsByStatus` (workspace-scoped, computed over the
// workspace's non-deleted channels). Same coverage — re-expressed against the trunk's aggregate.
const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let schema: typeof import("@/db/schema");
let encryptTokens: typeof import("@/lib/crypto").encryptTokens;
let listChannels: typeof import("./service").listChannels;
let seedWorkspace: typeof import("../../../tests/helpers/workspace").seedWorkspace;
type ChannelStatus = import("./service").ChannelStatus;
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
  ({ listChannels } = await import("./service"));
  ({ seedWorkspace } = await import("../../../tests/helpers/workspace"));
  WS = await seedWorkspace(db, schema, { slug: `dash-agg-${Date.now()}` });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(schema.channels).where(eq(schema.channels.workspace_id, WS));
  await db.delete(schema.workspaces).where(eq(schema.workspaces.id, WS));
  await db.$client.end();
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.delete(schema.channels).where(eq(schema.channels.workspace_id, WS));
});

async function channel(status: ChannelStatus, n = 1): Promise<void> {
  for (let i = 0; i < n; i++) {
    await db.insert(schema.channels).values({
      workspace_id: WS,
      platform: "instagram",
      platform_id: `acct-${status}-${i}-${Math.random()}`,
      connection_mode: "manual_token",
      status,
      token_encrypted: encryptTokens({ access_token: "t" }),
      webhook_secret: "wh",
    });
  }
}

const counts = async () => (await listChannels({ workspaceId: WS, limit: 200 })).countsByStatus;

describe("channel status counts (dashboard aggregate)", () => {
  it("returns 0 for every status when there are no channels", async () => {
    if (!TEST_DB) return;
    expect(await counts()).toEqual({ active: 0, needs_reauth: 0, paused: 0, disabled: 0 });
  });

  it("groups channels by status (within the workspace)", async () => {
    if (!TEST_DB) return;
    await channel("active", 3);
    await channel("needs_reauth", 2);
    await channel("paused", 1);
    await channel("disabled", 4);
    expect(await counts()).toEqual({ active: 3, needs_reauth: 2, paused: 1, disabled: 4 });
  });

  it("counts only the calling workspace's channels (tenancy)", async () => {
    if (!TEST_DB) return;
    await channel("active", 2);
    const WS2 = await seedWorkspace(db, schema, { slug: `dash-agg2-${Date.now()}` });
    await db.insert(schema.channels).values({
      workspace_id: WS2,
      platform: "instagram",
      platform_id: `other-${Math.random()}`,
      connection_mode: "manual_token",
      status: "active",
      token_encrypted: encryptTokens({ access_token: "t" }),
      webhook_secret: "wh",
    });
    expect((await counts()).active).toBe(2);
    await db.delete(schema.channels).where(eq(schema.channels.workspace_id, WS2));
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, WS2));
  });
});

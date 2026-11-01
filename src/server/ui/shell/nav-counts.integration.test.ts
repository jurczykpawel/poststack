import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

// UXFLOW1 stage 1: sidebar counters — open conversations with unread messages, pending approvals,
// channels that need re-auth — all scoped by workspace.
const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let schema: typeof import("@/db/schema");
let seedWorkspace: typeof import("../../../../tests/helpers/workspace").seedWorkspace;
let loadNavCounts: typeof import("./nav-counts").loadNavCounts;
let WS = "", OTHER = "";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY = "test-encryption-key-at-least-32-characters-long";
  process.env.JWT_SECRET ??= "test-secret-at-least-32-characters-long";
  process.env.APP_URL ??= "http://localhost:3000";
  process.env.CRON_SECRET ??= "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  schema = await import("@/db/schema");
  ({ seedWorkspace } = await import("../../../../tests/helpers/workspace"));
  ({ loadNavCounts } = await import("./nav-counts"));
  WS = await seedWorkspace(db, schema, { slug: `nc-${Math.random().toString(36).slice(2)}` });
  OTHER = await seedWorkspace(db, schema, { slug: `nc-${Math.random().toString(36).slice(2)}` });
});
afterAll(async () => {
  if (!TEST_DB) return;
  for (const id of [WS, OTHER]) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, id));
  await db.$client.end();
});

describe.skipIf(!TEST_DB)("loadNavCounts", () => {
  it("counts only this workspace's unread open conversations, pending approvals and reauth channels", async () => {
    expect(await loadNavCounts(WS)).toEqual({ inbox: 0, approvals: 0, channels: 0 });
    const mk = async (ws: string, status: "active" | "needs_reauth") => {
      const [c] = await db.insert(schema.channels).values({
        workspace_id: ws, platform: "instagram", platform_id: `ig-${Math.random()}`,
        connection_mode: "oauth", status, token_encrypted: "x", webhook_secret: "wh",
      }).returning({ id: schema.channels.id });
      return c!.id;
    };
    const ch = await mk(WS, "needs_reauth");
    await mk(WS, "active");
    await mk(OTHER, "needs_reauth");
    const conv = async (ws: string, channel: string, unread: number, status: "open" | "closed") => {
      const [ct] = await db.insert(schema.contacts).values({ workspace_id: ws, display_name: "Seed" }).returning({ id: schema.contacts.id });
      const [cv] = await db.insert(schema.conversations).values({ workspace_id: ws, channel_id: channel, contact_id: ct!.id, platform: "instagram", status, unread_count: unread }).returning({ id: schema.conversations.id, contact_id: schema.conversations.contact_id });
      return cv!;
    };
    const first = await conv(WS, ch, 2, "open");
    await db.insert(schema.pendingApprovals).values({ workspace_id: WS, conversation_id: first.id, contact_id: first.contact_id, channel_id: ch, recipient_platform_id: "r1", proposed_content: "Thanks!" });
    await conv(WS, ch, 0, "open");
    await conv(WS, ch, 5, "closed");
    const counts = await loadNavCounts(WS);
    expect(counts.inbox).toBe(1);
    expect(counts.channels).toBe(1);
    expect(counts.approvals).toBe(1);
  });
});

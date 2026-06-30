import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";

// WHOBS1: loadUnhandledTypes groups classified-but-unhandled inbound events by type so an
// arriving-but-unrouted webhook type is noticed. Includes the workspace's own channels AND
// instance-wide channel-less rows (test events / unknown pages); excludes handled events.
const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let schema: typeof import("@/db/schema");
let encryptTokens: typeof import("@/lib/crypto").encryptTokens;
let seedWorkspace: typeof import("../../../tests/helpers/workspace").seedWorkspace;
let loadUnhandledTypes: typeof import("./dashboard").loadUnhandledTypes;
let renderUnhandledTypes: typeof import("./dashboard").renderUnhandledTypes;
let WS = "", CH = "";

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
  ({ seedWorkspace } = await import("../../../tests/helpers/workspace"));
  ({ loadUnhandledTypes, renderUnhandledTypes } = await import("./dashboard"));
});
afterAll(async () => { if (TEST_DB) { await db.delete(schema.workspaces).where(eq(schema.workspaces.id, WS)); await db.$client.end(); } });
beforeEach(async () => {
  if (!TEST_DB) return;
  if (WS) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, WS));
  await db.delete(schema.webhookEvents).where(sql`channel_id IS NULL`);
  WS = await seedWorkspace(db, schema, { slug: `whobs-${Math.random().toString(36).slice(2)}` });
  const [c] = await db.insert(schema.channels).values({
    workspace_id: WS, platform: "instagram", platform_id: `ig-${Math.random()}`,
    connection_mode: "oauth", status: "active",
    token_encrypted: encryptTokens({ access_token: "T" }), webhook_secret: "wh",
  }).returning({ id: schema.channels.id });
  CH = c!.id;
});

async function ev(opts: { status: string; eventType: string; field?: string; channel?: string | null; object?: string }) {
  await db.insert(schema.webhookEvents).values({
    event_key: `k-${Math.random()}`, event_type: opts.eventType, field: opts.field ?? null,
    raw: {}, channel_id: opts.channel === undefined ? CH : opts.channel, object: opts.object ?? "instagram",
    platform: "instagram",
    handling_status: opts.status as typeof schema.webhookEvents.$inferInsert.handling_status,
  });
}

describe("WHOBS1 loadUnhandledTypes", () => {
  it("groups unhandled + unknown by type, excludes handled, includes null-channel", async () => {
    if (!TEST_DB) return;
    await ev({ status: "unhandled", eventType: "comment", field: "live_comments" });   // workspace unhandled
    await ev({ status: "unhandled", eventType: "comment", field: "live_comments" });   // same type → count 2
    await ev({ status: "unhandled", eventType: "unknown", field: "mentions" });        // unknown
    await ev({ status: "fired", eventType: "comment", field: "comments" });            // HANDLED → excluded
    await ev({ status: "recorded", eventType: "post_reaction", field: "feed" });       // HANDLED → excluded
    await ev({ status: "unhandled", eventType: "unknown", field: "message_reactions", channel: null }); // instance-wide

    const rows = await loadUnhandledTypes([CH]);
    const key = (r: { field: string | null; eventType: string }) => `${r.field}/${r.eventType}`;
    const byKey = new Map(rows.map((r) => [key(r), r]));

    expect(byKey.get("live_comments/comment")?.count).toBe(2);
    expect(byKey.get("mentions/unknown")?.count).toBe(1);
    expect(byKey.get("message_reactions/unknown")?.count).toBe(1); // null-channel surfaced
    expect(byKey.has("comments/comment")).toBe(false);  // fired excluded
    expect(byKey.has("feed/post_reaction")).toBe(false); // recorded excluded
  });

  it("renders a breakdown table, and an explicit empty state when nothing is unrouted", async () => {
    if (!TEST_DB) return;
    expect(renderUnhandledTypes([]).toString()).toContain("every inbound event type");
    await ev({ status: "unhandled", eventType: "comment", field: "live_comments" });
    const html = renderUnhandledTypes(await loadUnhandledTypes([CH])).toString();
    expect(html).toContain("live_comments");
  });
});

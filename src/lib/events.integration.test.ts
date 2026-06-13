import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { PoolClient } from "pg";

// REALTIME1 · R1: emitting an event also fires pg_notify('realtime', {ws,kind,id}) on the same tx,
// so the (Phase-3) SSE hub can fan it out. Here we LISTEN on a dedicated connection and assert the
// notification lands with the right workspace-scoped payload.
const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let schema: typeof import("@/db/schema");
let events: typeof import("@/lib/events");
let seedWorkspace: typeof import("../../tests/helpers/workspace").seedWorkspace;
let WS = "";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY = "test-encryption-key-at-least-32-characters-long";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  schema = await import("@/db/schema");
  events = await import("@/lib/events");
  ({ seedWorkspace } = await import("../../tests/helpers/workspace"));
  WS = await seedWorkspace(db, schema, { slug: `evt-${Date.now()}` });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(schema.events).where(eq(schema.events.workspace_id, WS));
  await db.delete(schema.workspaces).where(eq(schema.workspaces.id, WS));
  await db.$client.end();
});

describe("event bus + realtime NOTIFY", () => {
  it("emitEventNow writes a workspace-scoped event row AND fires a realtime NOTIFY", async () => {
    if (!TEST_DB) return;
    const client = (await db.$client.connect()) as PoolClient;
    const received: unknown[] = [];
    client.on("notification", (msg) => {
      if (msg.channel === "realtime" && msg.payload) received.push(JSON.parse(msg.payload));
    });
    await client.query("LISTEN realtime");
    try {
      await events.emitEventNow(WS, "post.published", { type: "post", id: "abc-123" }, { ok: true });
      // give the notification a tick to arrive
      await new Promise((r) => setTimeout(r, 150));
      const hit = received.find((p): p is { ws: string; kind: string; id: string } =>
        !!p && typeof p === "object" && (p as { id?: string }).id === "abc-123",
      );
      expect(hit).toBeTruthy();
      expect(hit!.ws).toBe(WS);
      expect(hit!.kind).toBe("post.published");
      // and the event row exists, scoped to the workspace
      const row = await db.query.events.findFirst({ where: eq(schema.events.subject_id, "abc-123") });
      expect(row!.workspace_id).toBe(WS);
      expect(row!.type).toBe("post.published");
    } finally {
      await client.query("UNLISTEN realtime").catch(() => {});
      client.release();
    }
  });
});

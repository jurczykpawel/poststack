import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let confirmEcho: typeof import("./echo").confirmEcho;
let logEvent: typeof import("@/lib/idempotency").logEvent;

const WS = "cccccccc-0000-0000-0000-0000000000e1";
const CH = "cccccccc-0000-0000-0000-0000000000e2";
const CH2 = "cccccccc-0000-0000-0000-0000000000e3";
const KEYS = ["echo-MATCH", "echo-NOMATCH", "echo-CROSS"];

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  ({ confirmEcho } = await import("./echo"));
  ({ logEvent } = await import("@/lib/idempotency"));
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.delete(s.webhookEvents).where(inArray(s.webhookEvents.event_key, KEYS));
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.insert(s.workspaces).values({ id: WS, name: "E", slug: `echo-${WS}` });
  await db.insert(s.channels).values([
    { id: CH, workspace_id: WS, platform: "facebook", platform_id: "PG-E1", token_encrypted: "x", webhook_secret: "s" },
    { id: CH2, workspace_id: WS, platform: "facebook", platform_id: "PG-E2", token_encrypted: "x", webhook_secret: "s" },
  ]);
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.webhookEvents).where(inArray(s.webhookEvents.event_key, KEYS));
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
});

describe("confirmEcho (real Postgres)", () => {
  it("stamps confirmed_by_echo_at + links the delivery + marks the event ignored on a match", async () => {
    if (!TEST_DB) return;
    await db.insert(s.outboundDeliveries).values({
      delivery_key: "dk-m", workspace_id: WS, channel_id: CH, task_name: "outgoing-message",
      status: "sent", payload: {}, platform_message_id: "MID-MATCH",
    });
    await logEvent({ event_key: "echo-MATCH", event_type: "echo", raw: {}, channel_id: CH, is_echo: true, platform_message_id: "MID-MATCH" });

    await confirmEcho("echo-MATCH", "MID-MATCH", CH);

    const del = await db.query.outboundDeliveries.findFirst({ where: eq(s.outboundDeliveries.delivery_key, "dk-m") });
    expect(del?.confirmed_by_echo_at).toBeTruthy();
    const ev = await db.query.webhookEvents.findFirst({ where: eq(s.webhookEvents.event_key, "echo-MATCH") });
    expect(ev?.handling_status).toBe("ignored");
    expect(ev?.outbound_delivery_id).toBe(del?.id);
  });

  it("marks a non-matching echo ignored without touching any delivery", async () => {
    if (!TEST_DB) return;
    await db.insert(s.outboundDeliveries).values({
      delivery_key: "dk-nm", workspace_id: WS, channel_id: CH, task_name: "outgoing-message",
      status: "sent", payload: {}, platform_message_id: "OTHER-MID",
    });
    await logEvent({ event_key: "echo-NOMATCH", event_type: "echo", raw: {}, channel_id: CH, is_echo: true, platform_message_id: "UNKNOWN-MID" });

    await confirmEcho("echo-NOMATCH", "UNKNOWN-MID", CH);

    const del = await db.query.outboundDeliveries.findFirst({ where: eq(s.outboundDeliveries.delivery_key, "dk-nm") });
    expect(del?.confirmed_by_echo_at).toBeNull();
    const ev = await db.query.webhookEvents.findFirst({ where: eq(s.webhookEvents.event_key, "echo-NOMATCH") });
    expect(ev?.handling_status).toBe("ignored");
    expect(ev?.outbound_delivery_id).toBeNull();
  });

  it("does not confirm a same-mid delivery on a different channel", async () => {
    if (!TEST_DB) return;
    // A delivery with the same mid but on a DIFFERENT channel must not be confirmed by this echo.
    await db.insert(s.outboundDeliveries).values({
      delivery_key: "dk-cross", workspace_id: WS, channel_id: CH2, task_name: "outgoing-message",
      status: "sent", payload: {}, platform_message_id: "MID-CROSS",
    });
    await logEvent({ event_key: "echo-CROSS", event_type: "echo", raw: {}, channel_id: CH, is_echo: true, platform_message_id: "MID-CROSS" });

    await confirmEcho("echo-CROSS", "MID-CROSS", CH);

    const del = await db.query.outboundDeliveries.findFirst({ where: eq(s.outboundDeliveries.delivery_key, "dk-cross") });
    expect(del?.confirmed_by_echo_at).toBeNull(); // different channel — untouched
  });

  it("does not re-stamp confirmed_by_echo_at on a redelivered echo (keeps the first timestamp)", async () => {
    if (!TEST_DB) return;
    await db.insert(s.outboundDeliveries).values({
      delivery_key: "dk-m", workspace_id: WS, channel_id: CH, task_name: "outgoing-message",
      status: "sent", payload: {}, platform_message_id: "MID-MATCH",
    });
    await logEvent({ event_key: "echo-MATCH", event_type: "echo", raw: {}, channel_id: CH, is_echo: true, platform_message_id: "MID-MATCH" });
    await confirmEcho("echo-MATCH", "MID-MATCH", CH);
    const first = await db.query.outboundDeliveries.findFirst({ where: eq(s.outboundDeliveries.delivery_key, "dk-m") });
    // A redelivered echo runs confirmEcho again (always-enqueue afterLog). The IS NULL guard must
    // keep the original timestamp rather than overwrite it with a later one.
    await new Promise((r) => setTimeout(r, 20));
    await confirmEcho("echo-MATCH", "MID-MATCH", CH);
    const second = await db.query.outboundDeliveries.findFirst({ where: eq(s.outboundDeliveries.delivery_key, "dk-m") });
    expect(second?.confirmed_by_echo_at?.getTime()).toBe(first?.confirmed_by_echo_at?.getTime());
  });
});

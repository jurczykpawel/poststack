import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let idem: typeof import("./idempotency");

const KEYS = ["idem-absent", "idem-received", "idem-conc", "idem-log", "idem-term", "idem-mark"];

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  idem = await import("./idempotency");
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.delete(s.webhookEvents).where(inArray(s.webhookEvents.event_key, KEYS));
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.webhookEvents).where(inArray(s.webhookEvents.event_key, KEYS));
});

describe("idempotency on webhook_events (real Postgres)", () => {
  it("claimEvent on an absent row inserts received→fired and returns true; second returns false", async () => {
    if (!TEST_DB) return;
    const first = await idem.claimEvent("idem-absent", "fired", {}, db, { event_type: "message" });
    expect(first).toBe(true);
    const row = await db.query.webhookEvents.findFirst({ where: eq(s.webhookEvents.event_key, "idem-absent") });
    expect(row?.handling_status).toBe("fired");
    expect(row?.handled_at).toBeTruthy();
    const second = await idem.claimEvent("idem-absent", "fired", {}, db, { event_type: "message" });
    expect(second).toBe(false);
  });

  it("claimEvent CAS a logged 'received' row to terminal once", async () => {
    if (!TEST_DB) return;
    const { created } = await idem.logEvent({ event_key: "idem-received", event_type: "message", raw: { a: 1 } });
    expect(created).toBe(true);
    const claimed = await idem.claimEvent("idem-received", "no_match");
    expect(claimed).toBe(true);
    const again = await idem.claimEvent("idem-received", "no_match");
    expect(again).toBe(false);
    const row = await db.query.webhookEvents.findFirst({ where: eq(s.webhookEvents.event_key, "idem-received") });
    expect(row?.handling_status).toBe("no_match");
  });

  it("two parallel claimEvent on the same key → exactly one true", async () => {
    if (!TEST_DB) return;
    await idem.logEvent({ event_key: "idem-conc", event_type: "reaction", raw: {} });
    const [a, b] = await Promise.all([
      idem.claimEvent("idem-conc", "fired"),
      idem.claimEvent("idem-conc", "fired"),
    ]);
    expect([a, b].filter(Boolean).length).toBe(1);
  });

  it("logEvent dedups on event_key: second call returns created=false, one row", async () => {
    if (!TEST_DB) return;
    expect((await idem.logEvent({ event_key: "idem-log", event_type: "message", raw: {} })).created).toBe(true);
    expect((await idem.logEvent({ event_key: "idem-log", event_type: "message", raw: {} })).created).toBe(false);
    const rows = await db.select().from(s.webhookEvents).where(eq(s.webhookEvents.event_key, "idem-log"));
    expect(rows.length).toBe(1);
  });

  it("isEventTerminal is false while received, true once claimed", async () => {
    if (!TEST_DB) return;
    await idem.logEvent({ event_key: "idem-term", event_type: "message", raw: {} });
    expect(await idem.isEventTerminal("idem-term")).toBe(false);
    await idem.claimEvent("idem-term", "fired");
    expect(await idem.isEventTerminal("idem-term")).toBe(true);
  });

  it("markEventStatus transitions only a received row (idempotent)", async () => {
    if (!TEST_DB) return;
    await idem.logEvent({ event_key: "idem-mark", event_type: "story_reply", raw: {} });
    await idem.markEventStatus("idem-mark", "unhandled");
    let row = await db.query.webhookEvents.findFirst({ where: eq(s.webhookEvents.event_key, "idem-mark") });
    expect(row?.handling_status).toBe("unhandled");
    // A second mark with a different status must NOT overwrite a now-terminal row.
    await idem.markEventStatus("idem-mark", "ignored");
    row = await db.query.webhookEvents.findFirst({ where: eq(s.webhookEvents.event_key, "idem-mark") });
    expect(row?.handling_status).toBe("unhandled");
  });

  it("claimEvent records outcome links", async () => {
    if (!TEST_DB) return;
    // Use a real contact id so the FK holds; reuse the idem-absent key after clearing.
    await db.delete(s.webhookEvents).where(eq(s.webhookEvents.event_key, "idem-absent"));
    const [ws] = await db.insert(s.workspaces).values({ name: "I", slug: `idem-${Date.now()}` }).returning({ id: s.workspaces.id });
    const [contact] = await db.insert(s.contacts).values({ workspace_id: ws.id }).returning({ id: s.contacts.id });
    await idem.claimEvent("idem-absent", "fired", { contact_id: contact.id }, db, { event_type: "message" });
    const row = await db.query.webhookEvents.findFirst({ where: eq(s.webhookEvents.event_key, "idem-absent") });
    expect(row?.contact_id).toBe(contact.id);
    await db.delete(s.workspaces).where(eq(s.workspaces.id, ws.id));
  });
});

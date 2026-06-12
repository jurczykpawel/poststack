import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const TEST_DB = process.env.TEST_DATABASE_URL;

let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let loadOverview: typeof import("@/lib/stats/overview").loadOverview;

const WS = "0ad0aaaa-0000-0000-0000-0000000000c1";
const CH = "0ad0aaaa-0000-0000-0000-0000000000c2";
const CONTACT = "0ad0aaaa-0000-0000-0000-0000000000c3";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  ({ loadOverview } = await import("@/lib/stats/overview"));
});

async function seedDelivery(
  key: string,
  taskName: string,
  status: "sent" | "failed" | "held" | "pending",
  createdAt: Date,
  contactId: string | null = CONTACT,
) {
  await db.insert(s.outboundDeliveries).values({
    delivery_key: key,
    workspace_id: WS,
    channel_id: CH,
    contact_id: contactId,
    task_name: taskName,
    status,
    payload: { type: "dm", text: "secret message text" },
    created_at: createdAt,
  });
}

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.insert(s.workspaces).values({ id: WS, name: "Ov", slug: `ov-${WS}` });
  await db.insert(s.channels).values({
    id: CH, workspace_id: WS, platform: "instagram", platform_id: "IG-OV",
    display_name: "Acct", token_encrypted: "x", webhook_secret: "s",
  });
  await db.insert(s.contacts).values({ id: CONTACT, workspace_id: WS, display_name: "Jan Kowalski" });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.$client.end();
});

describe("loadOverview", () => {
  it("aggregates delivery counts by status and counts today's sends", async () => {
    if (!TEST_DB) return;
    const now = new Date("2026-06-12T12:00:00Z");
    const yesterday = new Date("2026-06-11T12:00:00Z");
    await seedDelivery("d1", "outgoing-message", "sent", now);
    await seedDelivery("d2", "outgoing-message", "sent", yesterday);
    await seedDelivery("d3", "outgoing-comment", "failed", now);
    await seedDelivery("d4", "follow-gate", "held", now);

    const ov = await loadOverview(WS, { now });
    expect(ov.total).toBe(4);
    expect(ov.sent).toBe(2);
    expect(ov.failed).toBe(1);
    expect(ov.held).toBe(1);
    expect(ov.today).toBe(3); // d2 is yesterday
  });

  it("counts contacts as a bare number", async () => {
    if (!TEST_DB) return;
    const ov = await loadOverview(WS);
    expect(ov.contactCount).toBe(1);
  });

  it("returns an identity-free recent-sends log (label/platform/status/time only)", async () => {
    if (!TEST_DB) return;
    const now = new Date("2026-06-12T12:00:00Z");
    await seedDelivery("r1", "outgoing-message", "sent", new Date("2026-06-12T11:00:00Z"));
    await seedDelivery("r2", "sequence-step", "sent", new Date("2026-06-12T11:30:00Z"));

    const ov = await loadOverview(WS, { now });
    expect(ov.recentSends.length).toBe(2);
    // Newest first.
    expect(ov.recentSends[0].label).toBe("Sequence step");
    expect(ov.recentSends[1].label).toBe("DM");
    expect(ov.recentSends[0].platform).toBe("instagram");
    expect(ov.recentSends[0].status).toBe("sent");

    // No client identity may leak through the log shape.
    const serialized = JSON.stringify(ov.recentSends);
    expect(serialized).not.toContain(CONTACT);
    expect(serialized).not.toContain("secret message text");
    expect(serialized).not.toContain("Jan Kowalski");
    expect(Object.keys(ov.recentSends[0])).toEqual(["id", "label", "platform", "status", "createdAt"]);
  });

  it("respects logLimit", async () => {
    if (!TEST_DB) return;
    const base = new Date("2026-06-12T10:00:00Z").getTime();
    for (let i = 0; i < 5; i++) {
      await seedDelivery(`lim-${i}`, "outgoing-message", "sent", new Date(base + i * 1000));
    }
    const ov = await loadOverview(WS, { logLimit: 3 });
    expect(ov.recentSends.length).toBe(3);
  });

  it("scopes everything to the workspace", async () => {
    if (!TEST_DB) return;
    await seedDelivery("scoped", "outgoing-message", "sent", new Date());
    const other = await loadOverview("0ad0aaaa-0000-0000-0000-0000000000ff");
    expect(other.total).toBe(0);
    expect(other.contactCount).toBe(0);
    expect(other.recentSends).toEqual([]);
  });
});

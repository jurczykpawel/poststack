import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");

const WS = "ffffffff-0000-0000-0000-0000000000c1";
const CH = "ffffffff-0000-0000-0000-0000000000c2";
const DK = "touch-onupdate-dk";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.insert(s.workspaces).values({ id: WS, name: "T", slug: `t-${WS}` });
  await db.insert(s.channels).values({ id: CH, workspace_id: WS, platform: "facebook", platform_id: "PG-T", token_encrypted: "x", webhook_secret: "s" });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
});

// outbound_deliveries.updated_at carries $onUpdate, so a plain update that omits the
// column still advances the timestamp (the only updated_at column that previously lacked this).
describe("outbound_deliveries.updated_at $onUpdate", () => {
  it("advances updated_at on an update that does not set it", async () => {
    if (!TEST_DB) return;
    const old = new Date(Date.now() - 86_400_000);
    await db.insert(s.outboundDeliveries).values({
      delivery_key: DK, workspace_id: WS, channel_id: CH, task_name: "outgoing-message", status: "pending", payload: {}, updated_at: old,
    });
    await db.update(s.outboundDeliveries).set({ status: "sent" }).where(eq(s.outboundDeliveries.delivery_key, DK));
    const [row] = await db.select().from(s.outboundDeliveries).where(eq(s.outboundDeliveries.delivery_key, DK));
    expect(row.updated_at.getTime()).toBeGreaterThan(old.getTime());
  });
});

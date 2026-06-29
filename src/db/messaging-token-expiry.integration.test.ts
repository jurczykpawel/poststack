import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");

const WS = "ffffffff-0000-0000-0000-0000000000d1";
const CH = "ffffffff-0000-0000-0000-0000000000d2";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.insert(s.workspaces).values({ id: WS, name: "T", slug: `t-${WS}` });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
});

// IGML3: messaging_token_expires_at is a plaintext "death-clock" column. The Instagram-Login
// messaging token itself stays inside the encrypted token_encrypted blob; this nullable column
// only surfaces its expiry so the refresh scan can find near-expiry channels and the UI can badge it.
describe("channels.messaging_token_expires_at death-clock", () => {
  it("persists and reads back a messagingTokenExpiresAt value", async () => {
    if (!TEST_DB) return;
    const exp = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000); // ~60 days out
    await db.insert(s.channels).values({
      id: CH,
      workspace_id: WS,
      platform: "instagram",
      platform_id: "IG-T",
      token_encrypted: "x",
      webhook_secret: "s",
      messaging_token_expires_at: exp,
    });
    const [row] = await db.select().from(s.channels).where(eq(s.channels.id, CH));
    expect(row.messaging_token_expires_at).toBeInstanceOf(Date);
    expect(row.messaging_token_expires_at?.getTime()).toBe(exp.getTime());
  });

  it("defaults to null when omitted (nullable)", async () => {
    if (!TEST_DB) return;
    const CH2 = "ffffffff-0000-0000-0000-0000000000d3";
    await db.insert(s.channels).values({
      id: CH2,
      workspace_id: WS,
      platform: "instagram",
      platform_id: "IG-T2",
      token_encrypted: "x",
      webhook_secret: "s",
    });
    const [row] = await db.select().from(s.channels).where(eq(s.channels.id, CH2));
    expect(row.messaging_token_expires_at).toBeNull();
  });
});

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { createHash } from "crypto";
import { and, eq, inArray } from "drizzle-orm";

// The queue boundary is irrelevant to DELETE / cross-workspace scoping; stub it so a missing
// graphile connection can't interfere.
vi.mock("@/lib/queue/client", () => ({
  addJobTx: vi.fn(async () => {}),
  addJob: vi.fn(async () => {}),
  closeQueue: vi.fn(async () => {}),
}));

const TEST_DB = process.env.TEST_DATABASE_URL;
const RAW_KEY = "rs_live_channel_route_key_abcdef01";

let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let PATCH: typeof import("./route").PATCH;
let DELETE: typeof import("./route").DELETE;

const WS_A = "cccccccc-0000-0000-0000-00000000000a";
const WS_B = "cccccccc-0000-0000-0000-00000000000b";
const CH_A = "cccccccc-0000-0000-0000-0000000000a2";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.TOKEN_ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  ({ PATCH, DELETE } = await import("./route"));
});

beforeEach(async () => {
  if (!TEST_DB) return;
  // sequence_enrollments.channel_id is RESTRICT, so the workspace cascade can't drop a channel
  // with a leftover enrollment — clear those for this channel first.
  await db.delete(s.sequenceEnrollments).where(eq(s.sequenceEnrollments.channel_id, CH_A));
  await db.delete(s.workspaces).where(inArray(s.workspaces.id, [WS_A, WS_B]));
  await db.insert(s.workspaces).values([
    { id: WS_A, name: "A", slug: `a-${WS_A}` },
    { id: WS_B, name: "B", slug: `b-${WS_B}` },
  ]);
  await db.insert(s.apiKeys).values({
    workspace_id: WS_A, name: "A key",
    key_hash: createHash("sha256").update(RAW_KEY).digest("hex"), key_prefix: "rs_live_ch",
  });
  await db.insert(s.channels).values({
    id: CH_A, workspace_id: WS_A, platform: "instagram", platform_id: "PG-CH-A",
    token_encrypted: "e", webhook_secret: "s", status: "active", display_name: "Original",
  });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.sequenceEnrollments).where(eq(s.sequenceEnrollments.channel_id, CH_A));
  await db.delete(s.workspaces).where(inArray(s.workspaces.id, [WS_A, WS_B]));
  await db.$client.end?.();
});

const reqAsA = (method: string, body?: unknown) =>
  new Request("http://x/api/v1/channels/x", {
    method,
    headers: { authorization: `Bearer ${RAW_KEY}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
const ctx = (channelId: string) => ({ params: Promise.resolve({ channelId }) });

// sequence_enrollments.channel_id is ON DELETE RESTRICT and enrollment rows linger
// after completion. Deleting a channel that ever had an enrollment must surface a clean 409,
// not an unhandled FK-violation 500.
describe("channel DELETE with a sequence enrollment (real Postgres)", () => {
  const SEQ = "cccccccc-0000-0000-0000-0000000000a3";
  const CONTACT = "cccccccc-0000-0000-0000-0000000000a4";

  async function seedEnrollment(status: "active" | "completed") {
    await db.insert(s.sequences).values({ id: SEQ, workspace_id: WS_A, name: "Drip" });
    await db.insert(s.contacts).values({ id: CONTACT, workspace_id: WS_A });
    await db.insert(s.sequenceEnrollments).values({
      sequence_id: SEQ, contact_id: CONTACT, channel_id: CH_A, status,
    });
  }

  it("returns 409 (not 500) when an active enrollment references the channel", async () => {
    if (!TEST_DB) return;
    await seedEnrollment("active");
    const res = await DELETE(reqAsA("DELETE"), ctx(CH_A));
    expect(res.status).toBe(409);
    // The channel is left intact for the operator to retry after clearing enrollments.
    expect(await db.query.channels.findFirst({ where: eq(s.channels.id, CH_A) })).toBeDefined();
  });

  it("returns 409 even when the enrollment is already completed (rows are not cleaned up)", async () => {
    if (!TEST_DB) return;
    await seedEnrollment("completed");
    const res = await DELETE(reqAsA("DELETE"), ctx(CH_A));
    expect(res.status).toBe(409);
  });

  it("deletes cleanly (204) when the channel has no enrollments", async () => {
    if (!TEST_DB) return;
    const res = await DELETE(reqAsA("DELETE"), ctx(CH_A));
    expect(res.status).toBe(204);
    expect(await db.query.channels.findFirst({ where: eq(s.channels.id, CH_A) })).toBeUndefined();
  });
});

// defense-in-depth: the mutation WHERE carries workspace_id alongside the PK, so a
// cross-workspace id can never alter another tenant's row even if the ownership precheck and
// the mutation ever diverge. Black-box behaviour is unchanged (404, row untouched).
describe("channel PATCH/DELETE is workspace-scoped (real Postgres)", () => {
  it("a key from another workspace cannot rename the channel (404, unchanged)", async () => {
    if (!TEST_DB) return;
    const bKey = "rs_live_channel_route_key_otherws1";
    await db.insert(s.apiKeys).values({
      workspace_id: WS_B, name: "B key",
      key_hash: createHash("sha256").update(bKey).digest("hex"), key_prefix: "rs_live_ch",
    });
    const res = await PATCH(
      new Request("http://x/api/v1/channels/x", {
        method: "PATCH",
        headers: { authorization: `Bearer ${bKey}`, "content-type": "application/json" },
        body: JSON.stringify({ display_name: "Hijacked" }),
      }),
      ctx(CH_A),
    );
    expect(res.status).toBe(404);
    const row = await db.query.channels.findFirst({ where: and(eq(s.channels.id, CH_A), eq(s.channels.workspace_id, WS_A)) });
    expect(row?.display_name).toBe("Original");
  });
});

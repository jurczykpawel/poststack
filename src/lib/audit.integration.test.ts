import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";

const TEST_DB = process.env.TEST_DATABASE_URL;

let prisma: typeof import("@/lib/prisma").prisma;
let recordAudit: typeof import("./audit").recordAudit;

const WS = "dddddddd-0000-0000-0000-000000000001";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  ({ prisma } = await import("@/lib/prisma"));
  ({ recordAudit } = await import("./audit"));
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.workspace.create({ data: { id: WS, name: "Audit", slug: `audit-${WS}` } });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.$disconnect();
});

describe("recordAudit (real Postgres)", () => {
  it("appends a queryable, workspace-scoped entry", async () => {
    if (!TEST_DB) return;

    await recordAudit({
      workspaceId: WS,
      actor: { type: "api_key", id: "api-key:k1" },
      action: "contact.erased",
      targetType: "contact",
      targetId: "co-9",
      metadata: { reason: "gdpr" },
    });

    const rows = await prisma.auditLog.findMany({ where: { workspace_id: WS } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_type: "api_key",
      actor_id: "api-key:k1",
      action: "contact.erased",
      target_id: "co-9",
    });
    expect(rows[0].metadata).toEqual({ reason: "gdpr" });
  });
});

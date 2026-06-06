import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createHash } from "crypto";

const TEST_DB = process.env.TEST_DATABASE_URL;
const RAW_KEY = "rs_live_smoke_ownership_key_abcdef";

let prisma: typeof import("@/lib/prisma").prisma;
let GET: typeof import("./[contactId]/route").GET;

const WS_A = "ffffffff-0000-0000-0000-00000000000a";
const WS_B = "ffffffff-0000-0000-0000-00000000000b";
const CONTACT_A = "ffffffff-0000-0000-0000-0000000000a1";
const CONTACT_B = "ffffffff-0000-0000-0000-0000000000b1";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.TOKEN_ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";

  ({ prisma } = await import("@/lib/prisma"));
  ({ GET } = await import("./[contactId]/route"));
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await prisma.workspace.deleteMany({ where: { id: { in: [WS_A, WS_B] } } });
  await prisma.workspace.create({ data: { id: WS_A, name: "A", slug: `a-${WS_A}` } });
  await prisma.workspace.create({ data: { id: WS_B, name: "B", slug: `b-${WS_B}` } });
  await prisma.contact.create({ data: { id: CONTACT_A, workspace_id: WS_A } });
  await prisma.contact.create({ data: { id: CONTACT_B, workspace_id: WS_B } });
  await prisma.apiKey.create({
    data: {
      workspace_id: WS_A,
      name: "A key",
      key_hash: createHash("sha256").update(RAW_KEY).digest("hex"),
      key_prefix: "rs_live_smoke",
    },
  });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await prisma.workspace.deleteMany({ where: { id: { in: [WS_A, WS_B] } } });
  await prisma.$disconnect();
});

function reqAsA() {
  return new Request("http://x/api/v1/contacts/x", {
    headers: { authorization: `Bearer ${RAW_KEY}` },
  });
}
const ctx = (contactId: string) => ({ params: Promise.resolve({ contactId }) });

describe("ownership scoping via Bearer API key (real Postgres)", () => {
  it("reads a contact in the key's own workspace", async () => {
    if (!TEST_DB) return;
    const res = await GET(reqAsA(), ctx(CONTACT_A));
    expect(res.status).toBe(200);
  });

  it("cannot read a contact in another workspace (404, not cross-workspace leak)", async () => {
    if (!TEST_DB) return;
    const res = await GET(reqAsA(), ctx(CONTACT_B));
    expect(res.status).toBe(404);
  });

  it("rejects an unknown key", async () => {
    if (!TEST_DB) return;
    const res = await GET(
      new Request("http://x/api/v1/contacts/x", { headers: { authorization: "Bearer rs_live_nope" } }),
      ctx(CONTACT_A),
    );
    expect(res.status).toBe(401);
  });
});

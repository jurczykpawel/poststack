import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createHash } from "crypto";
import { and, eq } from "drizzle-orm";
import { licenseInstance } from "@/lib/license/__fixtures__/license-instance";

const TEST_DB = process.env.TEST_DATABASE_URL;
const RAW_KEY = "sk_live_contact_patch_key_abcd01234567";

let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let PATCH: typeof import("./route").PATCH;

const WS = "c0ffee00-0000-4000-8000-000000000c01";
const CT = "c0ffee00-0000-4000-8000-000000000c02";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  ({ PATCH } = await import("./route"));
  await licenseInstance();
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.insert(s.workspaces).values({ id: WS, name: "C", slug: `c-${WS}` });
  await db.insert(s.contacts).values({ id: CT, workspace_id: WS, display_name: "Anna" });
  await db.insert(s.apiKeys).values({ workspace_id: WS, name: "k", key_hash: createHash("sha256").update(RAW_KEY).digest("hex"), key_prefix: "sk_live_cp" });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.delete(s.instanceLicense);
});

const patch = (body: unknown) =>
  PATCH(
    new Request(`http://x/api/v1/contacts/${CT}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${RAW_KEY}` },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ contactId: CT }) },
  );

const updatedEvents = () =>
  db.select().from(s.events).where(and(eq(s.events.workspace_id, WS), eq(s.events.type, "contact.updated")));

describe.skipIf(!TEST_DB)("PATCH /api/v1/contacts/:id — contact.updated [APIFIX2]", () => {
  it("emits contact.updated when a scalar field changes", async () => {
    const res = await patch({ display_name: "Anna B" });
    expect(res.status).toBe(200);
    const ev = await updatedEvents();
    expect(ev).toHaveLength(1);
    expect(ev[0].subject_id).toBe(CT);
  });

  it("does not emit on a no-op PATCH (empty body)", async () => {
    const res = await patch({});
    expect(res.status).toBe(200);
    expect(await updatedEvents()).toHaveLength(0);
  });
});

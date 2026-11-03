import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { licenseInstance } from "@/lib/license/__fixtures__/license-instance";

// AIPROVIDER1: instance_* permissions can only be granted by the instance operator, and the creator is remembered.
const TEST_DB = process.env.TEST_DATABASE_URL;
const WS = "a1a1a1a1-0000-0000-0000-0000000000b1";
const OP = "a1a1a1a1-0000-0000-0000-0000000000b2";
const MEMBER = "a1a1a1a1-0000-0000-0000-0000000000b3";
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let route: typeof import("./route");
let cookies: { op: string; member: string };

const post = (cookie: string, scopes: string[]) =>
  route.POST(new Request("http://x/api/v1/api-keys", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "k", scopes }) }));

beforeAll(async () => {
  if (!TEST_DB) return;
  Object.assign(process.env, {
    DATABASE_URL: TEST_DB, JWT_SECRET: "test-secret-at-least-32-characters-long", APP_URL: "http://localhost:3000",
    ENCRYPTION_KEY: "0000000000000000000000000000000000000000000000000000000000000001", CRON_SECRET: "test-cron-secret-at-least-32-characters-long",
  });
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  route = await import("./route");
  Object.assign((await import("@/lib/env")).env, { INSTANCE_ADMIN_EMAILS: `op-${OP}@test.local` });
  const { signSession } = await import("@/lib/auth");
  cookies = { op: `session=${await signSession(OP, WS)}`, member: `session=${await signSession(MEMBER, WS)}` };
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  for (const id of [OP, MEMBER]) await db.delete(s.users).where(eq(s.users.id, id));
  await db.insert(s.users).values([{ id: OP, email: `op-${OP}@test.local` }, { id: MEMBER, email: `m-${MEMBER}@test.local` }]);
  await db.insert(s.workspaces).values({ id: WS, name: "IS", slug: `is-${WS}` });
  await db.insert(s.workspaceMembers).values([{ workspace_id: WS, user_id: OP, role: "owner" }, { workspace_id: WS, user_id: MEMBER, role: "owner" }]);
  await db.delete(s.instanceLicense);
  await licenseInstance("pro");
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  for (const id of [OP, MEMBER]) await db.delete(s.users).where(eq(s.users.id, id));
  await db.delete(s.instanceLicense);
});

describe("API key creation with instance scopes", () => {
  it("lets the operator grant instance_ai:* and stores who created the key", async () => {
    if (!TEST_DB) return;
    const res = await post(cookies.op, ["instance_ai:read", "instance_ai:write"]);
    expect(res.status).toBe(201);
    const row = await db.query.apiKeys.findFirst({ where: eq(s.apiKeys.id, (await res.json()).data.id) });
    expect(row?.created_by_user_id).toBe(OP);
    expect(row?.scopes).toEqual(["instance_ai:read", "instance_ai:write"]);
  });

  it("refuses a non-operator member (403) and stores no key", async () => {
    if (!TEST_DB) return;
    const before = (await db.query.apiKeys.findMany({ where: eq(s.apiKeys.workspace_id, WS) })).length;
    const res = await post(cookies.member, ["channels:read", "instance_ai:write"]);
    expect(res.status).toBe(403);
    expect((await db.query.apiKeys.findMany({ where: eq(s.apiKeys.workspace_id, WS) })).length).toBe(before);
  });

  it("still lets a member create an ordinary key, and records the creator on it too", async () => {
    if (!TEST_DB) return;
    const res = await post(cookies.member, ["channels:read"]);
    expect(res.status).toBe(201);
    const row = await db.query.apiKeys.findFirst({ where: eq(s.apiKeys.id, (await res.json()).data.id) });
    expect(row?.created_by_user_id).toBe(MEMBER);
  });
});

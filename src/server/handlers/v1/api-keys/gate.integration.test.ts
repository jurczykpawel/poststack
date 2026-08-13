import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { licenseInstance } from "@/lib/license/__fixtures__/license-instance";
import { API_SCOPES } from "@/lib/auth/scopes";

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let route: typeof import("./route");
let signSession: typeof import("@/lib/auth").signSession;
let gate: typeof import("@/lib/license/gate");
let closeQueue: typeof import("@/lib/queue/client").closeQueue;

const WS = "e2e2e2e2-0000-0000-0000-0000000000a1";
const USER = "e2e2e2e2-0000-0000-0000-0000000000a2";
let cookie: string;

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  route = await import("./route");
  ({ signSession } = await import("@/lib/auth"));
  gate = await import("@/lib/license/gate");
  ({ closeQueue } = await import("@/lib/queue/client"));
  cookie = `session=${await signSession(USER, WS)}`;
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.delete(s.users).where(eq(s.users.id, USER));
  await db.insert(s.users).values({ id: USER, email: `u-${USER}@test.local` });
  await db.insert(s.workspaces).values({ id: WS, name: "KG", slug: `kg-${WS}` });
  await db.insert(s.workspaceMembers).values({ workspace_id: WS, user_id: USER, role: "owner" });
  await db.delete(s.rateLimitCounters).where(eq(s.rateLimitCounters.key, `rl:apikey:${WS}`));
  await db.delete(s.instanceLicense);
  gate.invalidateLicenseCache();
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.delete(s.users).where(eq(s.users.id, USER));
  await db.delete(s.instanceLicense);
  gate.invalidateLicenseCache();
  if (closeQueue) await closeQueue();
});

function postKey() {
  return new Request("http://x/api/v1/api-keys", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "k", scopes: ["channels:read"] }),
  });
}

function postKeyWith(name: string, scopes: unknown) {
  return new Request("http://x/api/v1/api-keys", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name, scopes }),
  });
}

describe("POST /api/v1/api-keys — api_access PRO gate", () => {
  it("blocks creating a key without a PRO license (402)", async () => {
    if (!TEST_DB) return;
    const res = await route.POST(postKey());
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error.code).toBe("pro_required");
    const keys = await db.query.apiKeys.findMany({ where: eq(s.apiKeys.workspace_id, WS) });
    expect(keys).toHaveLength(0);
  });

  it("allows creating a key with a PRO license (201, returns plaintext once)", async () => {
    if (!TEST_DB) return;
    await licenseInstance("pro");
    const res = await route.POST(postKey());
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.key).toMatch(/^sk_live_/);
  });

  it("exposes the complete API-key scope catalog", async () => {
    if (!TEST_DB) return;
    expect(route.VALID_SCOPES).toBe(API_SCOPES);
  });

  it.each([
    ["empty", []],
    ["duplicate", ["channels:read", "channels:read"]],
    ["unknown", ["channels:read", "unknown:write"]],
  ] as const)("rejects a %s permission set without storing a key", async (name, scopes) => {
    if (!TEST_DB) return;
    await licenseInstance("pro");
    const res = await route.POST(postKeyWith(name, scopes));
    expect(res.status).toBe(422);
    const stored = await db.query.apiKeys.findFirst({
      where: and(eq(s.apiKeys.workspace_id, WS), eq(s.apiKeys.name, name)),
      columns: { id: true },
    });
    expect(stored).toBeUndefined();
  });

  it("requires callers to provide permissions explicitly", async () => {
    if (!TEST_DB) return;
    await licenseInstance("pro");
    const req = new Request("http://x/api/v1/api-keys", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "omitted" }),
    });
    expect((await route.POST(req)).status).toBe(422);
  });

  it("stores select-all as the explicit current catalog", async () => {
    if (!TEST_DB) return;
    await licenseInstance("pro");
    const res = await route.POST(postKeyWith("all-explicit", API_SCOPES));
    expect(res.status).toBe(201);
    const stored = await db.query.apiKeys.findFirst({
      where: and(eq(s.apiKeys.workspace_id, WS), eq(s.apiKeys.name, "all-explicit")),
      columns: { scopes: true },
    });
    expect(stored?.scopes).toEqual(API_SCOPES);
  });

  it("accepts every publishing scope", async () => {
    if (!TEST_DB) return;
    await licenseInstance("pro");
    const req = new Request("http://x/api/v1/api-keys", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        name: "editorial",
        scopes: [
          "content:read", "content:write",
          "posts:read", "posts:write",
          "brands:read", "brands:write",
          "media:write",
        ],
      }),
    });
    const res = await route.POST(req);
    expect(res.status).toBe(201);
    const stored = await db.query.apiKeys.findFirst({
      where: and(eq(s.apiKeys.workspace_id, WS), eq(s.apiKeys.name, "editorial")),
      columns: { scopes: true },
    });
    expect(stored?.scopes).toEqual([
      "content:read", "content:write",
      "posts:read", "posts:write",
      "brands:read", "brands:write",
      "media:write",
    ]);
  });
});

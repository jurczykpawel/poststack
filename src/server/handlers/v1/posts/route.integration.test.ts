import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createHash } from "crypto";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";

const TEST_DB = process.env.TEST_DATABASE_URL;
const KEY = "sk_live_posts_key_abcd000000000001";
const OTHER_KEY = "sk_live_posts_other_abcd0000000002";

let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let app: Hono;

const WS = "c0ffee08-0000-4000-8000-000000000d01";
const OTHER_WS = "c0ffee08-0000-4000-8000-000000000d02";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  const { buildApp } = await import("@/server/app");
  app = buildApp();
});

beforeEach(async () => {
  if (!TEST_DB) return;
  for (const ws of [WS, OTHER_WS]) await db.delete(s.workspaces).where(eq(s.workspaces.id, ws));
  await db.insert(s.workspaces).values([
    { id: WS, name: "W", slug: `w-${WS}` },
    { id: OTHER_WS, name: "O", slug: `o-${OTHER_WS}` },
  ]);
  const hash = (k: string) => createHash("sha256").update(k).digest("hex");
  await db.insert(s.apiKeys).values([
    { workspace_id: WS, name: "k", key_hash: hash(KEY), key_prefix: "sk_live_ps" },
    { workspace_id: OTHER_WS, name: "o", key_hash: hash(OTHER_KEY), key_prefix: "sk_live_po" },
  ]);
});

afterAll(async () => {
  if (!TEST_DB) return;
  for (const ws of [WS, OTHER_WS]) await db.delete(s.workspaces).where(eq(s.workspaces.id, ws));
  await db.$client.end();
});

function call(method: string, path: string, body?: unknown, key: string | null = KEY) {
  return app.request(`/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function createOne(over: Record<string, unknown> = {}, key = KEY) {
  const res = await call("POST", "/posts", { platform: "instagram", description: "hi", ...over }, key);
  return { res, json: await res.json() };
}

describe.skipIf(!TEST_DB)("/api/v1/posts", () => {
  it("creates a post and returns it (camelCase)", async () => {
    const { res, json } = await createOne();
    expect(res.status).toBe(201);
    expect(json.data).toMatchObject({ platform: "instagram", description: "hi" });
    expect(json.data.id).toBeTruthy();
  });

  it("rejects a post with no platform (422)", async () => {
    expect((await call("POST", "/posts", { description: "no platform" })).status).toBe(422);
  });

  it("lists posts scoped to the workspace", async () => {
    const { json } = await createOne();
    await createOne({}, OTHER_KEY);
    const list = await (await call("GET", "/posts")).json();
    expect(Array.isArray(list.data.items)).toBe(true);
    const ids = list.data.items.map((p: { id: string }) => p.id);
    expect(ids).toContain(json.data.id);
    expect(ids).toHaveLength(1); // OTHER_WS post excluded
  });

  it("GET item; PATCH updates; 404 on unknown", async () => {
    const { json } = await createOne();
    expect((await call("GET", `/posts/${json.data.id}`)).status).toBe(200);
    const patched = await call("PATCH", `/posts/${json.data.id}`, { description: "edited" });
    expect(patched.status).toBe(200);
    expect((await patched.json()).data.description).toBe("edited");
    expect((await call("GET", "/posts/00000000-0000-4000-8000-000000000000")).status).toBe(404);
  });

  it("DELETE removes it (then GET is 404)", async () => {
    const { json } = await createOne();
    expect((await call("DELETE", `/posts/${json.data.id}`)).status).toBe(204);
    expect((await call("GET", `/posts/${json.data.id}`)).status).toBe(404);
  });

  it("publish requires a channelId (422)", async () => {
    const { json } = await createOne();
    expect((await call("POST", `/posts/${json.data.id}/publish`, {})).status).toBe(422);
  });

  it("is tenant-isolated: another workspace cannot read, patch, or delete (404)", async () => {
    const { json } = await createOne();
    expect((await call("GET", `/posts/${json.data.id}`, undefined, OTHER_KEY)).status).toBe(404);
    expect((await call("PATCH", `/posts/${json.data.id}`, { description: "x" }, OTHER_KEY)).status).toBe(404);
    expect((await call("DELETE", `/posts/${json.data.id}`, undefined, OTHER_KEY)).status).toBe(404);
    expect(await db.query.posts.findFirst({ where: eq(s.posts.id, json.data.id) })).toBeTruthy();
  });

  it("401 without auth", async () => {
    expect((await call("GET", "/posts", undefined, null)).status).toBe(401);
  });
});

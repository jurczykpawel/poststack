import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createHash } from "crypto";
import { and, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { licenseInstance } from "@/lib/license/__fixtures__/license-instance";

const TEST_DB = process.env.TEST_DATABASE_URL;
const KEY = "sk_live_tags_edit_key_abcd00000001";
const OTHER_KEY = "sk_live_tags_edit_other_abcd000002";

let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let app: Hono;

const WS = "c0ffee05-0000-4000-8000-000000000c01";
const OTHER_WS = "c0ffee05-0000-4000-8000-000000000c02";
const CONTACT = "c0ffee05-0000-4000-8000-000000000c03";

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
  await licenseInstance("pro");
  for (const ws of [WS, OTHER_WS]) await db.delete(s.workspaces).where(eq(s.workspaces.id, ws));
  await db.insert(s.workspaces).values([
    { id: WS, name: "W", slug: `w-${WS}` },
    { id: OTHER_WS, name: "O", slug: `o-${OTHER_WS}` },
  ]);
  await db.insert(s.contacts).values({ id: CONTACT, workspace_id: WS });
  const hash = (k: string) => createHash("sha256").update(k).digest("hex");
  await db.insert(s.apiKeys).values([
    { workspace_id: WS, name: "k", key_hash: hash(KEY), key_prefix: "sk_live_tg" },
    { workspace_id: OTHER_WS, name: "o", key_hash: hash(OTHER_KEY), key_prefix: "sk_live_to" },
  ]);
});

afterAll(async () => {
  if (!TEST_DB) return;
  for (const ws of [WS, OTHER_WS]) await db.delete(s.workspaces).where(eq(s.workspaces.id, ws));
  await db.delete(s.instanceLicense);
  await db.$client.end();
});

function call(method: string, path: string, body?: unknown, key: string | null = KEY) {
  return app.request(`/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function seedTag(name: string, ws = WS) {
  const [t] = await db.insert(s.tags).values({ workspace_id: ws, name, color: "#111111" }).returning({ id: s.tags.id });
  return t!.id;
}

describe.skipIf(!TEST_DB)("/api/v1/tags/:tagId — edit + delete", () => {
  it("PATCH updates name and color", async () => {
    const id = await seedTag("lead");
    const res = await call("PATCH", `/tags/${id}`, { name: "customer", color: "#abcdef" });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data).toMatchObject({ id, name: "customer", color: "#abcdef" });
  });

  it("PATCH with a name that collides with another tag returns 409 (case-insensitive)", async () => {
    await seedTag("VIP");
    const id = await seedTag("lead");
    const res = await call("PATCH", `/tags/${id}`, { name: "vip" });
    expect(res.status).toBe(409);
  });

  it("PATCH to the tag's own name (same casing) is allowed (no self-conflict)", async () => {
    const id = await seedTag("lead");
    const res = await call("PATCH", `/tags/${id}`, { name: "lead", color: "#222222" });
    expect(res.status).toBe(200);
    expect((await res.json()).data.color).toBe("#222222");
  });

  it("PATCH rejects a bad color (422)", async () => {
    const id = await seedTag("lead");
    const res = await call("PATCH", `/tags/${id}`, { color: "red" });
    expect(res.status).toBe(422);
  });

  it("PATCH on an unknown id is 404", async () => {
    const res = await call("PATCH", "/tags/00000000-0000-4000-8000-000000000000", { name: "x" });
    expect(res.status).toBe(404);
  });

  it("DELETE removes the tag and cascades its contact links", async () => {
    const id = await seedTag("lead");
    await db.insert(s.contactTags).values({ contact_id: CONTACT, tag_id: id });
    const res = await call("DELETE", `/tags/${id}`);
    expect(res.status).toBe(204);
    expect(await db.query.tags.findFirst({ where: eq(s.tags.id, id) })).toBeUndefined();
    const links = await db.select().from(s.contactTags).where(eq(s.contactTags.tag_id, id));
    expect(links).toHaveLength(0); // cascaded
  });

  it("DELETE on an unknown id is 404", async () => {
    const res = await call("DELETE", "/tags/00000000-0000-4000-8000-000000000000");
    expect(res.status).toBe(404);
  });

  it("is tenant-isolated: another workspace cannot edit or delete the tag (404)", async () => {
    const id = await seedTag("lead");
    expect((await call("PATCH", `/tags/${id}`, { name: "x" }, OTHER_KEY)).status).toBe(404);
    expect((await call("DELETE", `/tags/${id}`, undefined, OTHER_KEY)).status).toBe(404);
    expect(await db.query.tags.findFirst({ where: and(eq(s.tags.id, id), eq(s.tags.workspace_id, WS)) })).toBeTruthy();
  });
});

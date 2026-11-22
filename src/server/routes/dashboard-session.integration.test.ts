import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { inArray } from "drizzle-orm";
import { apiKeys, brands, content, users, workspaces, workspaceMembers } from "@/db/schema";
import { licenseInstance } from "@/lib/license/__fixtures__/license-instance";
import type { Hono } from "hono";

let db: typeof import("@/lib/db").db;
let app: Hono;
let auth: typeof import("@/lib/auth");
let endpoints: typeof import("@/lib/webhooks/endpoints");
let cookie: string;
let key: string;
let own: string;
let other: string;
let ownContent: string;
let otherContent: string;
let secret: string;
const userIds: string[] = [];
const paths = ["/overview", "/inbox", "/channels", "/channels/pick/linkedin", "/content", "/brands", "/compose", "/queue", "/contacts", "/rules", "/sequences", "/approvals", "/sources", "/activity", "/engagement", "/insights", "/settings/api-keys", "/settings/ai", "/nav/counts", "/webhooks", "/webhooks/outbound"];

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL!;
  process.env.ENCRYPTION_KEY = "0".repeat(64);
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  ({ db } = await import("@/lib/db"));
  auth = await import("@/lib/auth");
  endpoints = await import("@/lib/webhooks/endpoints");
  app = (await import("../app")).buildApp();
  await licenseInstance("pro");
  for (const name of ["session-first", "session-second"]) {
    const [ws] = await db.insert(workspaces).values({ name, slug: `${name}-${crypto.randomUUID()}` }).returning();
    const [user] = await db.insert(users).values({ email: `${crypto.randomUUID()}@example.test` }).returning();
    userIds.push(user.id);
    await db.insert(workspaceMembers).values({ user_id: user.id, workspace_id: ws.id });
    const [item] = await db.insert(content).values({ workspace_id: ws.id, title: name, script: `${name} private script` }).returning();
    await db.insert(brands).values({ workspace_id: ws.id, key: name, name });
    if (!own) {
      own = ws.id;
      ownContent = item.id;
      cookie = `session=${await auth.signSession(user.id, own)}`;
    } else {
      other = ws.id;
      otherContent = item.id;
      const generated = auth.generateApiKey();
      key = generated.plaintext;
      await db.insert(apiKeys).values({ workspace_id: other, name, key_hash: generated.hash, key_prefix: generated.prefix, scopes: ["brands:read"] });
    }
  }
  secret = (await endpoints.createEndpoint(own, { url: "https://hooks.example.test/first" })).secret;
  await endpoints.createEndpoint(other, { url: "https://hooks.example.test/second" });
});

afterAll(async () => {
  await (await import("@/lib/realtime/hub")).stopRealtimeListener();
  await (await import("@/lib/queue/client")).closeQueue();
  await db.delete(workspaces).where(inArray(workspaces.id, [own, other]));
  await db.delete(users).where(inArray(users.id, userIds));
  await db.$client.end();
});

describe("dashboard session requests", () => {
  it.each(paths.flatMap(path => [false, true].map(hx => ({ path, hx }))))("requires session-only headers on $path (hx=$hx)", async ({ path, hx }) => {
    const res = await app.request(path, { headers: { cookie, Authorization: `Bearer ${key}`, ...(hx ? { "HX-Request": "true" } : {}) } });
    expect(hx ? res.headers.get("HX-Redirect") : res.headers.get("location")).toBe("/login");
    expect(await res.text()).not.toContain("session-second");
  });

  it("requires session-only headers for content details and form actions", async () => {
    for (const path of [`/content/${otherContent}`, `/content/${ownContent}`]) {
      const res = await app.request(path, { headers: { cookie, Authorization: `Bearer ${key}`, "HX-Request": "true" } });
      expect(res.headers.get("HX-Redirect")).toBe("/login");
      expect(await res.text()).not.toContain("private script");
    }
    const res = await app.request("/sources", { method: "POST", headers: { cookie, Authorization: `Bearer ${key}`, "HX-Request": "true", "content-type": "application/json" }, body: JSON.stringify({ name: "unused", type: "manual" }) });
    expect(res.headers.get("HX-Redirect")).toBe("/login");
  });

  it("retains scoped REST responses and requires a cookie for pages and streams", async () => {
    const headers = { Authorization: `Bearer ${key}` };
    expect((await app.request(`/api/v1/content/${otherContent}`, { headers })).status).toBe(403);
    expect((await app.request("/api/v1/webhooks", { headers })).status).toBe(403);
    expect((await app.request("/api/v1/brands", { headers })).status).toBe(200);
    expect((await app.request("/content", { headers })).headers.get("location")).toBe("/login");
    const stream = await app.request("/events/stream", { headers });
    await stream.body?.cancel();
    expect(stream.status).toBe(401);
    const mixed = await app.request("/events/stream", { headers: { ...headers, cookie } });
    await mixed.body?.cancel();
    expect(mixed.status).toBe(401);
    expect((await app.request("/", { headers })).status).toBe(200);
    expect((await app.request("/", { headers: { ...headers, cookie } })).status).toBe(200);
  });

  it("keeps routine endpoint HTML masked across repeated reads", async () => {
    for (let i = 0; i < 2; i++) {
      const res = await app.request("/webhooks/outbound", { headers: { cookie, "HX-Request": "true" } });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).not.toContain(secret);
      expect(html).not.toContain('x-ref="sec"');
    }
  });

  it.each([false, true])("accepts unknown activity platform filters (hx=%s)", async hx => {
    const res = await app.request("/activity?source=webhooks&platform=unknown-platform", { headers: { cookie, ...(hx ? { "HX-Request": "true" } : {}) } });
    expect(res.status).toBe(200);
  });

  it.each(["/content", "/brands", "/settings/api-keys", "/webhooks/outbound", "/activity", "/engagement", "/insights"])("does not store dashboard responses at %s", async path => {
    const res = await app.request(path, { headers: { cookie, "HX-Request": "true" } });
    expect(res.headers.get("Cache-Control")).toContain("no-store");
  });

  it("clears browser data through both logout endpoints and retires the old session", async () => {
    for (const path of ["/logout", "/api/auth/logout"]) {
      const freshCookie = `session=${await auth.signSession(userIds[0], own)}`;
      const res = await app.request(path, { method: "POST", headers: { cookie: freshCookie } });
      expect(res.headers.get("Clear-Site-Data")).toBe('"cache", "storage"');
      expect((await app.request("/content", { headers: { cookie: freshCookie } })).headers.get("location")).toBe("/login");
    }
  });

  it.each(["/logout", "/api/auth/logout"])("keeps the session when %s receives a different site", async path => {
    const sites: Record<string, string>[] = [{ "sec-fetch-site": "cross-site" }, { origin: "https://other.example.test" }];
    for (const headers of sites) {
      const freshCookie = `session=${await auth.signSession(userIds[0], own)}`;
      for (const withCookie of [false, true]) {
        const res = await app.request(path, { method: "POST", headers: { ...headers, ...(withCookie ? { cookie: freshCookie } : {}) } });
        expect(res.status).toBe(403);
        expect(res.headers.get("set-cookie")).toBeNull();
        expect(res.headers.get("Clear-Site-Data")).toBeNull();
      }
      expect(await auth.authenticateDashboard(new Request("http://localhost/content", { headers: { cookie: freshCookie } }))).not.toBeNull();
    }
  });
});

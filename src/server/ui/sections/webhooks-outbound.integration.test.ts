import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import { users, workspaces, rateLimitCounters } from "@/db/schema";
import type { Hono } from "hono";
import { licenseInstance } from "@/lib/license/__fixtures__/license-instance";

const TEST_DB = process.env.TEST_DATABASE_URL;
const EMAIL = "hono-wh-outbound@example.test";
const PASSWORD = "supersecret123";

let db: typeof import("@/lib/db").db;
let gate: typeof import("@/lib/license/gate");
let endpoints: typeof import("@/lib/webhooks/endpoints");
let closeQueue: typeof import("@/lib/queue/client").closeQueue;
let app: Hono;
let cookie = "";
let workspaceId = "";
const OTHER_WS = "c0ffee05-0000-4000-8000-000000000b02";

function cookieFrom(res: Response): string {
  const sc = res.headers.get("set-cookie") ?? "";
  const m = sc.match(/session=[^;]+/);
  return m ? m[0] : "";
}
const withCookie = (extra: Record<string, string> = {}) => ({ cookie, ...extra });

/** htmx form-encoded POST (the dashboard handlers parse a form body, not JSON). */
function form(path: string, fields: Record<string, string | string[]>, method = "POST") {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) {
    for (const one of Array.isArray(v) ? v : [v]) body.append(k, one);
  }
  return app.request(path, {
    method,
    headers: withCookie({ "content-type": "application/x-www-form-urlencoded", "HX-Request": "true" }),
    body: body.toString(),
  });
}

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  process.env.REGISTRATION_ENABLED = "true";
  delete process.env.ALTCHA_HMAC_KEY;
  ({ db } = await import("@/lib/db"));
  gate = await import("@/lib/license/gate");
  endpoints = await import("@/lib/webhooks/endpoints");
  ({ closeQueue } = await import("@/lib/queue/client"));
  const { buildApp } = await import("@/server/app");
  app = buildApp();
  await licenseInstance("pro"); // outbound_webhooks is core/pro

  await db.execute(sql.raw("DELETE FROM rate_limit_counters"));
  const prior = await db.query.users.findFirst({
    where: eq(users.email, EMAIL),
    columns: {},
    with: { workspaceMembers: { columns: { workspace_id: true } } },
  });
  for (const m of prior?.workspaceMembers ?? []) await db.delete(workspaces).where(eq(workspaces.id, m.workspace_id));
  await db.delete(users).where(eq(users.email, EMAIL));
  await db.delete(rateLimitCounters);
  await db.delete(workspaces); // single-tenant: clear leftovers so register isn't multitenant-locked
  const res = await app.request("/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  expect(res.status).toBe(204);
  cookie = cookieFrom(res);
  const user = await db.query.users.findFirst({
    where: eq(users.email, EMAIL),
    columns: {},
    with: { workspaceMembers: { columns: { workspace_id: true }, limit: 1 } },
  });
  workspaceId = user!.workspaceMembers[0].workspace_id;

  // A second tenant whose endpoints must never leak into this session.
  await db.delete(workspaces).where(eq(workspaces.id, OTHER_WS));
  await db.insert(workspaces).values({ id: OTHER_WS, name: "Other", slug: `other-${OTHER_WS}` });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(workspaces).where(eq(workspaces.id, OTHER_WS));
  if (workspaceId) await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  await db.delete(users).where(eq(users.email, EMAIL));
  if (closeQueue) await closeQueue();
  await db.$client.end();
});

describe.skipIf(!TEST_DB)("/webhooks/outbound dashboard", () => {
  it("creates an endpoint via the form; it appears in the list scoped to the workspace", async () => {
    const res = await form("/webhooks/outbound", { url: "https://hooks.example.com/created", event_types: ["post.published"] });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("https://hooks.example.com/created");
    expect(body).toContain("post.published");

    const rows = await endpoints.listEndpoints(workspaceId);
    const made = rows.find((r) => r.url === "https://hooks.example.com/created");
    expect(made).toBeTruthy();
    expect(made!.event_types).toEqual(["post.published"]);
    // Newly-minted secret is surfaced in the rendered panel (revealable).
    expect(body).toContain(made!.secret);
  });

  it("creates with no event types selected → subscribes to All events", async () => {
    const res = await form("/webhooks/outbound", { url: "https://hooks.example.com/allev" });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("All events");
    const made = (await endpoints.listEndpoints(workspaceId)).find((r) => r.url === "https://hooks.example.com/allev");
    expect(made!.event_types).toEqual([]);
  });

  it("toggles active off then on", async () => {
    const ep = await endpoints.createEndpoint(workspaceId, { url: "https://hooks.example.com/toggle" });
    expect(ep.active).toBe(true);
    const off = await form(`/webhooks/outbound/${ep.id}/toggle`, {});
    expect(off.status).toBe(200);
    expect((await endpoints.getEndpoint(workspaceId, ep.id))!.active).toBe(false);
    await form(`/webhooks/outbound/${ep.id}/toggle`, {});
    expect((await endpoints.getEndpoint(workspaceId, ep.id))!.active).toBe(true);
  });

  it("edits url + event types", async () => {
    const ep = await endpoints.createEndpoint(workspaceId, { url: "https://hooks.example.com/edit" });
    const res = await form(`/webhooks/outbound/${ep.id}`, { url: "https://hooks.example.com/edited", event_types: ["contact.created", "contact.updated"] });
    expect(res.status).toBe(200);
    const after = await endpoints.getEndpoint(workspaceId, ep.id);
    expect(after!.url).toBe("https://hooks.example.com/edited");
    expect(after!.event_types).toEqual(["contact.created", "contact.updated"]);
  });

  it("creates with custom headers + extra payload fields: headers encrypted (name shown, value never), extra fields prefilled for editing", async () => {
    const res = await form("/webhooks/outbound", {
      url: "https://hooks.example.com/hdr",
      headers: "Authorization: Bearer secret123",
      extra: '{"source":"poststack"}',
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain("secret123"); // value never rendered back
    expect(body).toContain("Authorization"); // name hint in the edit form
    expect(body).toContain('"source": "poststack"'); // not secret — prefilled for editing

    const made = (await endpoints.listEndpoints(workspaceId)).find((r) => r.url === "https://hooks.example.com/hdr");
    expect(made!.headers).toEqual({ Authorization: "Bearer secret123" });
    expect(made!.extra_payload_fields).toEqual({ source: "poststack" });
  });

  it("editing with the headers textarea left blank preserves existing headers (values are never echoed, so blank means unchanged)", async () => {
    const ep = await endpoints.createEndpoint(workspaceId, { url: "https://hooks.example.com/hpreserve", headers: { "X-Keep": "1" } });
    const res = await form(`/webhooks/outbound/${ep.id}`, { url: ep.url, headers: "" });
    expect(res.status).toBe(200);
    expect((await endpoints.getEndpoint(workspaceId, ep.id))!.headers).toEqual({ "X-Keep": "1" });
  });

  it("editing with new header lines replaces the stored headers", async () => {
    const ep = await endpoints.createEndpoint(workspaceId, { url: "https://hooks.example.com/hreplace", headers: { "X-Old": "1" } });
    const res = await form(`/webhooks/outbound/${ep.id}`, { url: ep.url, headers: "X-New: 2" });
    expect(res.status).toBe(200);
    expect((await endpoints.getEndpoint(workspaceId, ep.id))!.headers).toEqual({ "X-New": "2" });
  });

  it("leaving extra payload fields blank on edit clears them (they're visible, so blank is an intentional clear)", async () => {
    const ep = await endpoints.createEndpoint(workspaceId, { url: "https://hooks.example.com/eclear", extraFields: { a: 1 } });
    const res = await form(`/webhooks/outbound/${ep.id}`, { url: ep.url, extra: "" });
    expect(res.status).toBe(200);
    expect((await endpoints.getEndpoint(workspaceId, ep.id))!.extra_payload_fields).toEqual({});
  });

  it("rejects malformed extra-fields JSON with an inline notice (nothing changed)", async () => {
    const ep = await endpoints.createEndpoint(workspaceId, { url: "https://hooks.example.com/ebad", extraFields: { a: 1 } });
    const res = await form(`/webhooks/outbound/${ep.id}`, { url: ep.url, extra: "{not json" });
    expect(res.status).toBe(200);
    expect((await endpoints.getEndpoint(workspaceId, ep.id))!.extra_payload_fields).toEqual({ a: 1 }); // unchanged
  });

  it("rotates the signing secret (new secret, distinct)", async () => {
    const ep = await endpoints.createEndpoint(workspaceId, { url: "https://hooks.example.com/rotate" });
    const before = ep.secret;
    const res = await form(`/webhooks/outbound/${ep.id}/rotate`, {});
    expect(res.status).toBe(200);
    const after = await endpoints.getEndpoint(workspaceId, ep.id);
    expect(after!.secret).toMatch(/^whsec_[0-9a-f]{48}$/);
    expect(after!.secret).not.toBe(before);
  });

  it("deletes an endpoint", async () => {
    const ep = await endpoints.createEndpoint(workspaceId, { url: "https://hooks.example.com/delete-me" });
    const res = await app.request(`/webhooks/outbound/${ep.id}`, { method: "DELETE", headers: withCookie({ "HX-Request": "true" }) });
    expect(res.status).toBe(200);
    expect(await endpoints.getEndpoint(workspaceId, ep.id)).toBeUndefined();
  });

  it("rejects an invalid url with an inline notice (nothing created)", async () => {
    const before = (await endpoints.listEndpoints(workspaceId)).length;
    const res = await form("/webhooks/outbound", { url: "ftp://evil.example.com" });
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("ftp://evil.example.com");
    expect((await endpoints.listEndpoints(workspaceId)).length).toBe(before);
  });

  it("is tenant-isolated: another workspace's endpoint is neither listed nor mutable", async () => {
    const foreign = await endpoints.createEndpoint(OTHER_WS, { url: "https://hooks.example.com/foreign" });

    // Not listed in this session's panel.
    const panel = await (await app.request("/webhooks/outbound", { headers: withCookie() })).text();
    expect(panel).not.toContain("https://hooks.example.com/foreign");

    // Cross-tenant mutations are refused (404) and leave the foreign endpoint intact.
    expect((await form(`/webhooks/outbound/${foreign.id}/toggle`, {})).status).toBe(404);
    expect((await app.request(`/webhooks/outbound/${foreign.id}`, { method: "DELETE", headers: withCookie({ "HX-Request": "true" }) })).status).toBe(404);
    const still = await endpoints.getEndpoint(OTHER_WS, foreign.id);
    expect(still).toBeTruthy();
    expect(still!.active).toBe(true);
  });

  it("gates the panel + create behind PRO when the instance is unlicensed", async () => {
    await gate.clearLicense();
    try {
      const panel = await (await app.request("/webhooks/outbound", { headers: withCookie() })).text();
      expect(panel).toContain("PRO");
      expect(panel).not.toContain('hx-post="/webhooks/outbound"');

      const before = await endpoints.listEndpoints(workspaceId);
      const res = await form("/webhooks/outbound", { url: "https://hooks.example.com/should-not-create" });
      expect(res.status).toBe(200);
      expect((await endpoints.listEndpoints(workspaceId)).length).toBe(before.length); // gate enforced server-side
    } finally {
      await licenseInstance("pro"); // restore for any following work
    }
  });
});

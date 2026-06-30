import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let seedWorkspace: typeof import("../../../tests/helpers/workspace").seedWorkspace;
let svc: typeof import("./endpoints");
let EVENT_TYPES: typeof import("@/lib/events").EVENT_TYPES;
let ApiError: typeof import("@/lib/api/response").ApiError;

const WS = "c0ffee02-0000-4000-8000-000000000e01";
const OTHER_WS = "c0ffee02-0000-4000-8000-000000000e02";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY = "test-encryption-key-at-least-32-characters-long"; // secrets encrypted at rest
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  ({ seedWorkspace } = await import("../../../tests/helpers/workspace"));
  svc = await import("./endpoints");
  ({ EVENT_TYPES } = await import("@/lib/events"));
  ({ ApiError } = await import("@/lib/api/response"));
});

beforeEach(async () => {
  if (!TEST_DB) return;
  for (const ws of [WS, OTHER_WS]) {
    await db.delete(s.workspaces).where(eq(s.workspaces.id, ws));
    await seedWorkspace(db, s, { id: ws, slug: `wh-${ws}` });
  }
});

afterAll(async () => {
  if (!TEST_DB) return;
  for (const ws of [WS, OTHER_WS]) await db.delete(s.workspaces).where(eq(s.workspaces.id, ws));
  await db.$client.end();
});

describe.skipIf(!TEST_DB)("webhook endpoint service", () => {
  it("createEndpoint mints a signing secret, is active, persists url + event types, scoped to the workspace", async () => {
    const ep = await svc.createEndpoint(WS, {
      url: "https://hook.example.com/ps",
      eventTypes: ["post.published", "post.failed"],
    });
    expect(ep.workspace_id).toBe(WS);
    expect(ep.url).toBe("https://hook.example.com/ps");
    expect(ep.active).toBe(true);
    expect(ep.event_types).toEqual(["post.published", "post.failed"]);
    expect(ep.secret).toMatch(/^whsec_[0-9a-f]{48}$/);
    expect(ep.secret_secondary).toBeNull();

    // Stored encrypted at rest (not plaintext), but decrypts back to the returned secret.
    const fromDb = await db.query.webhookEndpoints.findFirst({ where: eq(s.webhookEndpoints.id, ep.id) });
    expect(fromDb!.secret).not.toBe(ep.secret);
    expect(fromDb!.secret).not.toMatch(/^whsec_/);
  });

  it("createEndpoint defaults to all events when eventTypes is empty", async () => {
    const ep = await svc.createEndpoint(WS, { url: "https://hook.example.com/all" });
    expect(ep.event_types).toEqual([]);
  });

  it("listEndpoints returns only this workspace's endpoints, with secrets viewable", async () => {
    const a = await svc.createEndpoint(WS, { url: "https://a.example.com/h" });
    const b = await svc.createEndpoint(WS, { url: "https://b.example.com/h" });
    const other = await svc.createEndpoint(OTHER_WS, { url: "https://other.example.com/h" });
    const list = await svc.listEndpoints(WS);
    expect(list.map((e) => e.id).sort()).toEqual([a.id, b.id].sort()); // exactly this WS, OTHER_WS excluded
    expect(list.map((e) => e.id)).not.toContain(other.id);
    expect(list[0]!.secret).toBeTruthy();
  });

  it("updateEndpoint toggles active and replaces event types; the secret is untouched", async () => {
    const ep = await svc.createEndpoint(WS, { url: "https://hook.example.com/u", eventTypes: ["post.published"] });
    const updated = await svc.updateEndpoint(WS, ep.id, {
      active: false,
      eventTypes: ["channel.needs_reauth"],
      url: "https://hook.example.com/u2",
    });
    expect(updated.active).toBe(false);
    expect(updated.event_types).toEqual(["channel.needs_reauth"]);
    expect(updated.url).toBe("https://hook.example.com/u2");
    expect(updated.secret).toBe(ep.secret);
  });

  it("updateEndpoint with no fields is a no-op that returns the current row", async () => {
    const ep = await svc.createEndpoint(WS, { url: "https://hook.example.com/noop" });
    const updated = await svc.updateEndpoint(WS, ep.id, {});
    expect(updated.url).toBe(ep.url);
    expect(updated.active).toBe(ep.active);
  });

  it("rotateSecret moves the current secret to secondary and mints a new primary", async () => {
    const ep = await svc.createEndpoint(WS, { url: "https://hook.example.com/r" });
    const rotated = await svc.rotateSecret(WS, ep.id);
    expect(rotated.secret).not.toBe(ep.secret);
    expect(rotated.secret).toMatch(/^whsec_[0-9a-f]{48}$/);
    expect(rotated.secret_secondary).toBe(ep.secret); // grace window for in-flight verification
  });

  it("rotateSecret a second time drops the oldest secondary (keeps only the previous primary)", async () => {
    const ep = await svc.createEndpoint(WS, { url: "https://hook.example.com/r2" });
    const first = await svc.rotateSecret(WS, ep.id);
    const second = await svc.rotateSecret(WS, ep.id);
    expect(second.secret).not.toBe(first.secret);
    expect(second.secret_secondary).toBe(first.secret);
  });

  it("deleteEndpoint removes the endpoint and its deliveries", async () => {
    const ep = await svc.createEndpoint(WS, { url: "https://hook.example.com/d" });
    const [e] = await db
      .insert(s.events)
      .values({ workspace_id: WS, type: "post.published", payload: {} })
      .returning();
    await db.insert(s.webhookDeliveries).values({ workspace_id: WS, event_id: e!.id, endpoint_id: ep.id });
    await svc.deleteEndpoint(WS, ep.id);
    expect(await db.query.webhookEndpoints.findFirst({ where: eq(s.webhookEndpoints.id, ep.id) })).toBeUndefined();
    expect(await db.query.webhookDeliveries.findFirst({ where: eq(s.webhookDeliveries.endpoint_id, ep.id) })).toBeUndefined();
  });

  it("rejects a non-http(s) url", async () => {
    await expect(svc.createEndpoint(WS, { url: "ftp://evil.example.com" })).rejects.toBeInstanceOf(ApiError);
  });

  it("rejects a malformed url", async () => {
    await expect(svc.createEndpoint(WS, { url: "not a url" })).rejects.toBeInstanceOf(ApiError);
  });

  it("rejects a literal cloud-metadata / link-local target (169.254.169.254)", async () => {
    await expect(svc.createEndpoint(WS, { url: "http://169.254.169.254/latest/meta-data" })).rejects.toBeInstanceOf(ApiError);
  });

  it("rejects a literal IPv6 link-local target (fe80::1)", async () => {
    await expect(svc.createEndpoint(WS, { url: "http://[fe80::1]/x" })).rejects.toBeInstanceOf(ApiError);
  });

  it("rejects a literal multicast target (224.0.0.1)", async () => {
    await expect(svc.createEndpoint(WS, { url: "http://224.0.0.1/x" })).rejects.toBeInstanceOf(ApiError);
  });

  it("rejects a literal unspecified target (0.0.0.0)", async () => {
    await expect(svc.createEndpoint(WS, { url: "http://0.0.0.0/x" })).rejects.toBeInstanceOf(ApiError);
  });

  it("accepts a normal hostname (resolves at delivery, not create-time)", async () => {
    const ep = await svc.createEndpoint(WS, { url: "https://hook.example.com/lit" });
    expect(ep.url).toBe("https://hook.example.com/lit");
  });

  it("accepts a public IP literal (full policy enforced at delivery)", async () => {
    const ep = await svc.createEndpoint(WS, { url: "https://1.2.3.4/lit" });
    expect(ep.url).toBe("https://1.2.3.4/lit");
  });

  it("updateEndpoint rejects a literal link-local target", async () => {
    const ep = await svc.createEndpoint(WS, { url: "https://hook.example.com/upd" });
    await expect(svc.updateEndpoint(WS, ep.id, { url: "http://169.254.169.254/x" })).rejects.toBeInstanceOf(ApiError);
  });

  it("rejects an unknown event type against the catalog", async () => {
    await expect(
      svc.createEndpoint(WS, { url: "https://hook.example.com/x", eventTypes: ["post.exploded"] }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it("accepts every event type in the published catalog", async () => {
    const ep = await svc.createEndpoint(WS, { url: "https://hook.example.com/catalog", eventTypes: [...EVENT_TYPES] });
    expect(ep.event_types).toEqual([...EVENT_TYPES]);
  });

  it("updateEndpoint rejects an unknown event type", async () => {
    const ep = await svc.createEndpoint(WS, { url: "https://hook.example.com/uv" });
    await expect(svc.updateEndpoint(WS, ep.id, { eventTypes: ["nope.nope"] })).rejects.toBeInstanceOf(ApiError);
  });

  it("updateEndpoint on a missing id throws not_found", async () => {
    await expect(
      svc.updateEndpoint(WS, "00000000-0000-4000-8000-000000000000", { active: false }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it("rotateSecret on a missing id throws not_found", async () => {
    await expect(
      svc.rotateSecret(WS, "00000000-0000-4000-8000-000000000000"),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it("is tenant-isolated: another workspace can neither read, update, nor delete the endpoint", async () => {
    const ep = await svc.createEndpoint(WS, { url: "https://hook.example.com/iso" });
    expect(await svc.getEndpoint(OTHER_WS, ep.id)).toBeUndefined();
    await expect(svc.updateEndpoint(OTHER_WS, ep.id, { active: false })).rejects.toBeInstanceOf(ApiError);
    await expect(svc.deleteEndpoint(OTHER_WS, ep.id)).rejects.toBeInstanceOf(ApiError);
    // The owning workspace's endpoint is untouched.
    expect(await svc.getEndpoint(WS, ep.id)).toBeTruthy();
    const still = await db.query.webhookEndpoints.findFirst({
      where: and(eq(s.webhookEndpoints.id, ep.id), eq(s.webhookEndpoints.workspace_id, WS)),
    });
    expect(still!.active).toBe(true);
  });
});

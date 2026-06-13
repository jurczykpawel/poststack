import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { users, workspaces, channels, deliveries } from "@/db/schema";
import { licenseInstance } from "@/lib/license/__fixtures__/license-instance";

const TEST_DB = process.env.TEST_DATABASE_URL;
const EMAIL = "queue-ui@example.test";
const PASSWORD = "supersecret123";

let db: typeof import("@/lib/db").db;
let encryptTokens: typeof import("@/lib/crypto").encryptTokens;
let closeQueue: typeof import("@/lib/queue/client").closeQueue;
let app: Hono;
let cookie = "";
let workspaceId = "";

function cookieFrom(res: Response): string {
  const sc = res.headers.get("set-cookie") ?? "";
  const m = sc.match(/session=[^;]+/);
  return m ? m[0] : "";
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
  ({ encryptTokens } = await import("@/lib/crypto"));
  ({ closeQueue } = await import("@/lib/queue/client"));
  const { buildApp } = await import("../../app");
  app = buildApp();
  await licenseInstance();

  const prior = await db.query.users.findFirst({
    where: eq(users.email, EMAIL), columns: {},
    with: { workspaceMembers: { columns: { workspace_id: true } } },
  });
  for (const m of prior?.workspaceMembers ?? []) await db.delete(workspaces).where(eq(workspaces.id, m.workspace_id));
  await db.delete(users).where(eq(users.email, EMAIL));
  const res = await app.request("/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  cookie = cookieFrom(res);
  const user = await db.query.users.findFirst({
    where: eq(users.email, EMAIL), columns: {},
    with: { workspaceMembers: { columns: { workspace_id: true }, limit: 1 } },
  });
  workspaceId = user!.workspaceMembers[0].workspace_id;
});

afterAll(async () => {
  if (!TEST_DB) return;
  if (workspaceId) await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  await db.delete(users).where(eq(users.email, EMAIL));
  if (closeQueue) await closeQueue();
  await db.$client.end();
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.delete(deliveries).where(eq(deliveries.workspace_id, workspaceId));
  await db.delete(channels).where(eq(channels.workspace_id, workspaceId));
});

async function seedDelivery(status: (typeof deliveries.$inferInsert)["status"], lastError?: string): Promise<{ chId: string; id: string }> {
  const [ch] = await db.insert(channels).values({
    workspace_id: workspaceId, platform: "instagram", platform_id: `acct-${Math.random()}`, display_name: "Queue Chan",
    token_encrypted: encryptTokens({ access_token: "t" }), webhook_secret: "w", status: "active",
  }).returning({ id: channels.id });
  const [d] = await db.insert(deliveries).values({
    workspace_id: workspaceId, channel_id: ch!.id, format: "reel", status,
    payload: { format: "reel", media: [] }, scheduled_at: new Date(), run_at: new Date(), last_error: lastError ?? null,
  }).returning({ id: deliveries.id });
  return { chId: ch!.id, id: d!.id };
}

const htmx = () => ({ cookie, "HX-Request": "true", "content-type": "application/x-www-form-urlencoded" });

describe("queue section", () => {
  it("redirects to login without a session", async () => {
    if (!TEST_DB) return;
    expect((await app.request("/queue")).status).toBe(302);
  });

  it("lists deliveries with status chips + channel", async () => {
    if (!TEST_DB) return;
    await seedDelivery("failed", "rate limited");
    const out = await (await app.request("/queue", { headers: { cookie } })).text();
    expect(out).toContain("Queue Chan");
    expect(out).toContain("reel");
    expect(out).toContain("rate limited");
  });

  it("detail renders the payload + last-error panel", async () => {
    if (!TEST_DB) return;
    const { id } = await seedDelivery("failed", "boom");
    const out = await (await app.request(`/queue/${id}`, { headers: { cookie } })).text();
    expect(out).toContain("Payload");
    expect(out).toContain("Last error");
    expect(out).toContain("boom");
  });

  it("retry re-queues a failed delivery (status flips off failed)", async () => {
    if (!TEST_DB) return;
    const { id } = await seedDelivery("failed");
    const res = await app.request(`/queue/${id}/retry`, { method: "POST", headers: htmx() });
    expect(res.status).toBe(200);
    const row = await db.query.deliveries.findFirst({ where: eq(deliveries.id, id) });
    expect(row!.status).not.toBe("failed");
  });

  it("cancel cancels a scheduled delivery", async () => {
    if (!TEST_DB) return;
    const { id } = await seedDelivery("scheduled");
    const res = await app.request(`/queue/${id}/cancel`, { method: "POST", headers: htmx() });
    expect(res.status).toBe(200);
    const row = await db.query.deliveries.findFirst({ where: eq(deliveries.id, id) });
    expect(row!.status).toBe("canceled");
  });

  it("a delivery id from another workspace 404s", async () => {
    if (!TEST_DB) return;
    const otherWs = (await db.insert(workspaces).values({ name: "Other", slug: `other-q-${Math.random().toString(36).slice(2)}` }).returning())[0].id;
    const [ch] = await db.insert(channels).values({ workspace_id: otherWs, platform: "instagram", platform_id: "x", token_encrypted: encryptTokens({ access_token: "t" }), webhook_secret: "w" }).returning({ id: channels.id });
    const [d] = await db.insert(deliveries).values({ workspace_id: otherWs, channel_id: ch!.id, format: "reel", status: "failed", payload: {}, scheduled_at: new Date(), run_at: new Date() }).returning({ id: deliveries.id });
    expect((await app.request(`/queue/${d!.id}`, { headers: { cookie } })).status).toBe(404);
    await db.delete(workspaces).where(eq(workspaces.id, otherWs));
  });
});

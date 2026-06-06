import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Hono } from "hono";

const TEST_DB = process.env.TEST_DATABASE_URL;
const EMAIL = "hono-pages@example.test";
const PASSWORD = "supersecret123";

let prisma: typeof import("@/lib/prisma").prisma;
let encryptTokens: typeof import("@/lib/crypto").encryptTokens;
let closeQueue: typeof import("@/lib/queue/client").closeQueue;
let app: Hono;
let cookie = "";
let workspaceId = "";

function cookieFrom(res: Response): string {
  const sc = res.headers.get("set-cookie") ?? "";
  const m = sc.match(/rs_session=[^;]+/);
  return m ? m[0] : "";
}

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.TOKEN_ENCRYPTION_KEY =
    "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  delete process.env.ALTCHA_HMAC_KEY;
  ({ prisma } = await import("@/lib/prisma"));
  ({ encryptTokens } = await import("@/lib/crypto"));
  ({ closeQueue } = await import("@/lib/queue/client"));
  const { buildApp } = await import("../app");
  app = buildApp();

  // Clear the shared rate-limit table so the once-per-run registration isn't
  // blocked by counters left over from other suites / earlier runs.
  await prisma.$executeRawUnsafe("DELETE FROM rate_limit_counters");
  await prisma.user.deleteMany({ where: { email: EMAIL } });
  const res = await app.request("/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  expect(res.status).toBe(204);
  cookie = cookieFrom(res);
  const user = await prisma.user.findUnique({
    where: { email: EMAIL },
    select: { workspace_members: { select: { workspace_id: true }, take: 1 } },
  });
  workspaceId = user!.workspace_members[0].workspace_id;
});

afterAll(async () => {
  if (!TEST_DB) return;
  // The reply test enqueues an outgoing-message; clear the shared queue for
  // serially-following suites.
  await prisma.$executeRawUnsafe("truncate table graphile_worker._private_jobs cascade");
  await prisma.user.deleteMany({ where: { email: EMAIL } });
  if (closeQueue) await closeQueue();
  await prisma.$disconnect();
});

const withCookie = (extra: Record<string, string> = {}) => ({ cookie, ...extra });

describe("authenticated dashboard (real Postgres)", () => {
  it("register issues a working session that renders the inbox", async () => {
    if (!TEST_DB) return;
    const res = await app.request("/inbox", { headers: withCookie() });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Select a conversation");
    expect(body).toContain("ReplyStack");
  });

  it("renders a seeded conversation and its thread, and accepts a reply", async () => {
    if (!TEST_DB) return;
    const channel = await prisma.channel.create({
      data: {
        workspace_id: workspaceId, platform: "facebook", platform_id: "PAGE_PG",
        display_name: "Page", token_encrypted: encryptTokens({ access_token: "tok" }),
        webhook_secret: "wh", status: "active",
      },
    });
    const contact = await prisma.contact.create({
      data: {
        workspace_id: workspaceId, display_name: "Jane Doe",
        contact_channels: { create: { channel_id: channel.id, platform_sender_id: "PSID1", platform_username: "jane" } },
      },
    });
    const conv = await prisma.conversation.create({
      data: {
        workspace_id: workspaceId, channel_id: channel.id, contact_id: contact.id,
        platform: "facebook", status: "open", last_message_preview: "hello there", unread_count: 2,
        messages: { create: { direction: "inbound", text: "hello there", status: "delivered" } },
      },
    });

    const list = await app.request("/inbox", { headers: withCookie() });
    expect(await list.text()).toContain("Jane Doe");

    const thread = await app.request(`/inbox/${conv.id}`, { headers: withCookie() });
    expect(thread.status).toBe(200);
    expect(await thread.text()).toContain("hello there");

    // opening the thread cleared unread
    const refreshed = await prisma.conversation.findUnique({ where: { id: conv.id }, select: { unread_count: true } });
    expect(refreshed!.unread_count).toBe(0);

    const reply = await app.request(`/inbox/${conv.id}/reply`, {
      method: "POST",
      headers: withCookie({ "content-type": "application/json" }),
      body: JSON.stringify({ text: "thanks!" }),
    });
    expect(reply.status).toBe(200);
    expect(await reply.text()).toContain("Jane Doe");
  });

  it("renders channels, contacts, rules, sequences, settings", async () => {
    if (!TEST_DB) return;
    for (const [path, marker] of [
      ["/channels", "Channels"],
      ["/contacts", "Contacts"],
      ["/rules", "Rules"],
      ["/sequences", "Sequences"],
      ["/settings", "API Keys"],
    ] as const) {
      const res = await app.request(path, { headers: withCookie() });
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).toContain(marker);
    }
  });

  it("creates an API key and shows the plaintext once", async () => {
    if (!TEST_DB) return;
    const res = await app.request("/settings/api-keys", {
      method: "POST",
      headers: withCookie({ "content-type": "application/json" }),
      body: JSON.stringify({ name: "CI key" }),
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("rs_live_");
    expect(body).toContain("CI key");
  });

  it("creates a keyword rule from the simplified form", async () => {
    if (!TEST_DB) return;
    const res = await app.request("/rules", {
      method: "POST",
      headers: withCookie({ "content-type": "application/json" }),
      body: JSON.stringify({ name: "Greet", keywords: "hi, hello", text: "Welcome!" }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Greet");
    const rule = await prisma.autoReplyRule.findFirst({ where: { workspace_id: workspaceId, name: "Greet" } });
    expect(rule?.trigger_type).toBe("keyword");
  });

  it("creates a sequence from line-based steps", async () => {
    if (!TEST_DB) return;
    const res = await app.request("/sequences", {
      method: "POST",
      headers: withCookie({ "content-type": "application/json" }),
      body: JSON.stringify({ name: "Onboarding", steps: "Hi\nDay two tip" }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Onboarding");
    const seq = await prisma.sequence.findFirst({ where: { workspace_id: workspaceId, name: "Onboarding" } });
    expect(Array.isArray(seq?.steps) ? (seq!.steps as unknown[]).length : 0).toBe(2);
  });
});

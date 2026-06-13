import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let wh: typeof import("./alert-webhook");
let alert: typeof import("./alert");
let closeQueue: typeof import("@/lib/queue/client").closeQueue;

const WS = "aaaaaaaa-0000-0000-0000-0000000000a1";
const realFetch = globalThis.fetch;

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.TOKEN_ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  delete process.env.CHANNEL_ALERT_WEBHOOK_URL;
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  wh = await import("./alert-webhook");
  alert = await import("./alert");
  ({ closeQueue } = await import("@/lib/queue/client"));
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.insert(s.workspaces).values({ id: WS, name: "AW", slug: `aw-${WS}` });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  if (closeQueue) await closeQueue();
});

describe("alert-webhook config (real Postgres)", () => {
  it("round-trips an encrypted header map (ciphertext at rest, plaintext on read)", async () => {
    if (!TEST_DB) return;
    await wh.upsertAlertWebhook(WS, { url: "https://example.com/hook", headers: { Authorization: "Bearer secret123" } });

    const row = await db.query.alertWebhooks.findFirst({ where: eq(s.alertWebhooks.workspace_id, WS) });
    expect(row?.custom_headers_encrypted).toBeTruthy();
    expect(row?.custom_headers_encrypted).not.toContain("secret123"); // encrypted at rest

    const cfg = await wh.getAlertWebhook(WS);
    expect(cfg?.headers).toEqual({ Authorization: "Bearer secret123" });
    // header NAMES only for the edit form (never values)
    expect(await wh.getAlertWebhookHeaderNames(WS)).toEqual(["Authorization"]);
  });

  it("upsert is a singleton per workspace (no duplicate rows)", async () => {
    if (!TEST_DB) return;
    await wh.upsertAlertWebhook(WS, { url: "https://a.example.com/1" });
    await wh.upsertAlertWebhook(WS, { url: "https://b.example.com/2", enabled: false });
    const rows = await db.query.alertWebhooks.findMany({ where: eq(s.alertWebhooks.workspace_id, WS) });
    expect(rows).toHaveLength(1);
    expect(rows[0].url).toBe("https://b.example.com/2");
    expect(rows[0].enabled).toBe(false);
  });
});

describe("dispatchAlert — uses the workspace's customized webhook (real Postgres)", () => {
  it("POSTs the customized body + custom headers to the configured url, not the env fallback", async () => {
    if (!TEST_DB) return;
    await wh.upsertAlertWebhook(WS, {
      url: "https://example.com/mailstack",
      headers: { "X-Api-Key": "k1" },
      fieldSelection: ["type", "display_name"],
      extraFields: { subject: "Connection {{display_name}} expires in {{days_left}} days" },
    });

    let captured: { url: string; headers: Record<string, string>; body: Record<string, unknown> } | null = null;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = {
        url: typeof input === "string" ? input : input.toString(),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init?.body)),
      };
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    await alert.dispatchAlert({
      type: "token_expiring",
      workspaceId: WS,
      sourceId: "src-1",
      displayName: "Acme",
      daysLeft: 7,
      detail: "soon",
    });

    expect(captured).not.toBeNull();
    const c = captured!;
    expect(c.url).toBe("https://example.com/mailstack");
    expect(c.headers["X-Api-Key"]).toBe("k1");
    // field selection kept only type+display_name from the standard body; extra subject was templated
    expect(c.body).toEqual({ type: "token_expiring", display_name: "Acme", subject: "Connection Acme expires in 7 days" });
  });
});

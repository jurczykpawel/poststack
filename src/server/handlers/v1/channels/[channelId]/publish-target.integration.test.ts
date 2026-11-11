import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import { createHash } from "crypto";
import { eq } from "drizzle-orm";
import docs from "../../../../../../tests/fixtures/provider-docs/telegram-responses.json";

vi.mock("@/lib/queue/client", () => ({ addJobTx: vi.fn(async () => {}), addJob: vi.fn(async () => {}), closeQueue: vi.fn(async () => {}) }));

const TEST_DB = process.env.TEST_DATABASE_URL;
const RAW_KEY = "sk_live_tg_publish_target_key_01";
const WS = "cccccccc-0000-0000-0000-0000000000e1";
const TG = "cccccccc-0000-0000-0000-0000000000e2";
const IG = "cccccccc-0000-0000-0000-0000000000e3";

let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let PATCH: typeof import("./route").PATCH;
let LIST: typeof import("../route").GET;

function telegram(chat: unknown, member: unknown) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const method = String(url).split("/").pop();
    const body = method === "getMe" ? docs.me : method === "getChat" ? chat : member;
    return new Response(JSON.stringify(body), { status: (body as { ok: boolean }).ok ? 200 : 400 });
  }));
}
const patch = (id: string, body: unknown) =>
  PATCH(new Request("http://x", { method: "PATCH", headers: { authorization: `Bearer ${RAW_KEY}`, "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ channelId: id }) });
const row = () => db.query.channels.findFirst({ where: eq(s.channels.id, TG) });

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  ({ PATCH } = await import("./route"));
  ({ GET: LIST } = await import("../route"));
});

beforeEach(async () => {
  if (!TEST_DB) return;
  const { encryptTokens } = await import("@/lib/crypto");
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.insert(s.workspaces).values({ id: WS, name: "TG", slug: `tg-${WS}` });
  await db.insert(s.apiKeys).values({ workspace_id: WS, name: "k", key_hash: createHash("sha256").update(RAW_KEY).digest("hex"), key_prefix: "sk_live_tg_pt" });
  await db.insert(s.channels).values([
    { id: TG, workspace_id: WS, platform: "telegram", platform_id: "777000111", token_encrypted: encryptTokens({ access_token: "123:SECRET" }), webhook_secret: "s", connection_mode: "manual_token" },
    { id: IG, workspace_id: WS, platform: "instagram", platform_id: "ig-pt", token_encrypted: "e", webhook_secret: "s" },
  ]);
});

afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
});

describe("PATCH /channels/:id publish_target (Telegram, real Postgres)", () => {
  it("saves the normalized target and the channel can publish afterwards", async () => {
    if (!TEST_DB) return;
    telegram(docs.chatChannel, docs.memberAdminCanPost);
    const res = await patch(TG, { publish_target: "-1001234567890" });
    expect(res.status).toBe(200);
    expect((await res.json()).data.publish_target).toBe("@acme_news");
    expect((await row())?.publish_target).toBe("@acme_news");
    const list = (await (await LIST(new Request("http://x", { headers: { authorization: `Bearer ${RAW_KEY}` } }))).json()).data;
    expect(list.find((c: { id: string }) => c.id === TG)).toMatchObject({ can_publish: true, publish_target: "@acme_news" });
  });

  it("refuses a bot that cannot post, keeps the old value, and explains how to fix it", async () => {
    if (!TEST_DB) return;
    await db.update(s.channels).set({ publish_target: "@old_channel" }).where(eq(s.channels.id, TG));
    telegram(docs.chatChannel, docs.memberAdminNoPost);
    await expect(patch(TG, { publish_target: "@acme_news" })).rejects.toMatchObject({ status: 422, message: expect.stringContaining("Add the bot as an administrator") });
    expect((await row())?.publish_target).toBe("@old_channel");
  });

  it("an empty value clears the target without calling Telegram", async () => {
    if (!TEST_DB) return;
    await db.update(s.channels).set({ publish_target: "@old_channel" }).where(eq(s.channels.id, TG));
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    expect((await patch(TG, { publish_target: null })).status).toBe(200);
    expect((await row())?.publish_target).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it("rejects a publish target on a non-Telegram channel", async () => {
    if (!TEST_DB) return;
    await expect(patch(IG, { publish_target: "@acme_news" })).rejects.toMatchObject({ status: 400 });
  });
});

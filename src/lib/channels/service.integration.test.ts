import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let schema: typeof import("@/db/schema");
let encryptTokens: typeof import("@/lib/crypto").encryptTokens;
let seedWorkspace: typeof import("../../../tests/helpers/workspace").seedWorkspace;
let svc: typeof import("./service");
let WS_A = "";
let WS_B = "";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY = "test-encryption-key-at-least-32-characters-long";
  process.env.JWT_SECRET ??= "test-secret-at-least-32-characters-long";
  process.env.APP_URL ??= "http://localhost:3000";
  process.env.CRON_SECRET ??= "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  schema = await import("@/db/schema");
  ({ encryptTokens } = await import("@/lib/crypto"));
  ({ seedWorkspace } = await import("../../../tests/helpers/workspace"));
  svc = await import("./service");
});

afterAll(async () => {
  if (!TEST_DB) return;
  if (WS_A) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, WS_A));
  if (WS_B) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, WS_B));
  await db.$client.end();
});

beforeEach(async () => {
  if (!TEST_DB) return;
  if (WS_A) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, WS_A));
  if (WS_B) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, WS_B));
  WS_A = await seedWorkspace(db, schema, { slug: `chsvc-a-${Math.random().toString(36).slice(2)}` });
  WS_B = await seedWorkspace(db, schema, { slug: `chsvc-b-${Math.random().toString(36).slice(2)}` });
});

async function makeChannel(ws: string, input: {
  platform: string;
  platformId: string;
  displayName?: string;
  status?: "active" | "disabled" | "needs_reauth" | "paused";
  connectionMode?: "oauth" | "manual_token" | "derived";
  hidden?: boolean;
  brandKey?: string | null;
}): Promise<string> {
  const [row] = await db
    .insert(schema.channels)
    .values({
      workspace_id: ws,
      platform: input.platform as (typeof schema.channels.$inferInsert)["platform"],
      platform_id: input.platformId,
      display_name: input.displayName ?? null,
      connection_mode: input.connectionMode ?? "oauth",
      status: input.status ?? "active",
      hidden_at: input.hidden ? new Date() : null,
      brand_key: input.brandKey ?? null,
      token_encrypted: encryptTokens({ access_token: "T" }),
      webhook_secret: "wh",
    })
    .returning({ id: schema.channels.id });
  return row.id;
}

describe("channels service — listChannels", () => {
  it("scopes rows + counts to the workspace (never leaks another workspace)", async () => {
    if (!TEST_DB) return;
    await makeChannel(WS_A, { platform: "facebook", platformId: "A-FB", displayName: "A Page" });
    await makeChannel(WS_A, { platform: "instagram", platformId: "A-IG", status: "needs_reauth" });
    await makeChannel(WS_B, { platform: "facebook", platformId: "B-FB", displayName: "B Page" });

    const a = await svc.listChannels({ workspaceId: WS_A });
    expect(a.items.map((c) => c.provider_account_id).sort()).toEqual(["A-FB", "A-IG"]);
    expect(a.countsByStatus.active).toBe(1);
    expect(a.countsByStatus.needs_reauth).toBe(1);
    expect(a.countsByPlatform).toEqual({ facebook: 1, instagram: 1 });
    // No B row anywhere.
    expect(a.items.some((c) => c.provider_account_id === "B-FB")).toBe(false);
  });

  it("filters by platform / status / q and hides hidden by default", async () => {
    if (!TEST_DB) return;
    await makeChannel(WS_A, { platform: "facebook", platformId: "FB1", displayName: "Acme FB" });
    await makeChannel(WS_A, { platform: "instagram", platformId: "IG1", displayName: "Acme IG" });
    await makeChannel(WS_A, { platform: "facebook", platformId: "FB2", displayName: "Hidden", hidden: true });

    expect((await svc.listChannels({ workspaceId: WS_A })).items).toHaveLength(2); // hidden excluded by default
    // showHidden is a filter chip like status/platform: it shows ONLY the hidden channels, not all.
    const onlyHidden = (await svc.listChannels({ workspaceId: WS_A, showHidden: true })).items;
    expect(onlyHidden.map((c) => c.provider_account_id)).toEqual(["FB2"]);
    expect((await svc.listChannels({ workspaceId: WS_A, platform: "facebook" })).items.map((c) => c.provider_account_id)).toEqual(["FB1"]);
    expect((await svc.listChannels({ workspaceId: WS_A, q: "IG" })).items).toHaveLength(1);
    // hiddenCount reflects the hidden row even when not shown.
    expect((await svc.listChannels({ workspaceId: WS_A })).hiddenCount).toBe(1);
  });

  it("maps the facebook/instagram subKind onto the platform filter", async () => {
    if (!TEST_DB) return;
    await makeChannel(WS_A, { platform: "facebook", platformId: "FB1" });
    await makeChannel(WS_A, { platform: "instagram", platformId: "IG1" });
    const fb = await svc.listChannels({ workspaceId: WS_A, subKind: "facebook_page" });
    expect(fb.items.map((c) => c.platform)).toEqual(["facebook"]);
  });
});

describe("channels service — getChannel + mutations are workspace-scoped", () => {
  it("getChannel returns own row, NEVER another workspace's", async () => {
    if (!TEST_DB) return;
    const idB = await makeChannel(WS_B, { platform: "facebook", platformId: "B-ONLY" });
    expect(await svc.getChannel(WS_B, idB)).toBeDefined();
    // The critical isolation invariant: A cannot read B's channel by id.
    expect(await svc.getChannel(WS_A, idB)).toBeUndefined();
  });

  it("mutations refuse a cross-workspace id (404)", async () => {
    if (!TEST_DB) return;
    const idB = await makeChannel(WS_B, { platform: "facebook", platformId: "B-MUT" });
    await expect(svc.setChannelStatus(WS_A, idB, "paused")).rejects.toThrow();
    await expect(svc.setChannelDisplayName(WS_A, idB, "hacked")).rejects.toThrow();
    await expect(svc.deleteChannel(WS_A, idB)).rejects.toThrow();
    // B's row is untouched.
    const stillThere = await svc.getChannel(WS_B, idB);
    expect(stillThere?.display_name).not.toBe("hacked");
    expect(stillThere?.status).toBe("active");
  });

  it("pause / rename / hide / delete mutate the own row", async () => {
    if (!TEST_DB) return;
    const id = await makeChannel(WS_A, { platform: "facebook", platformId: "OWN", displayName: "Old" });
    await svc.setChannelStatus(WS_A, id, "paused");
    expect((await svc.getChannel(WS_A, id))?.status).toBe("paused");
    await svc.setChannelDisplayName(WS_A, id, "New name");
    expect((await svc.getChannel(WS_A, id))?.display_name).toBe("New name");
    await svc.setChannelHidden(WS_A, id, true);
    expect((await svc.getChannel(WS_A, id))?.hidden_at).not.toBeNull();
    await svc.deleteChannel(WS_A, id);
    expect(await svc.getChannel(WS_A, id)).toBeUndefined(); // soft-deleted → excluded from reads
  });

  it("FIRSTCOMMENT1: setChannelDefaultFirstComment sets, trims, and clears the default", async () => {
    if (!TEST_DB) return;
    const id = await makeChannel(WS_A, { platform: "instagram", platformId: "FC1" });
    expect((await svc.getChannel(WS_A, id))?.default_first_comment).toBeNull();
    await svc.setChannelDefaultFirstComment(WS_A, id, "  Link in comments 👇  ");
    expect((await svc.getChannel(WS_A, id))?.default_first_comment).toBe("Link in comments 👇");
    // Empty / whitespace clears it back to off (NULL).
    await svc.setChannelDefaultFirstComment(WS_A, id, "   ");
    expect((await svc.getChannel(WS_A, id))?.default_first_comment).toBeNull();
  });

  it("FIRSTCOMMENT1: setChannelDefaultFirstComment refuses a cross-workspace id (404)", async () => {
    if (!TEST_DB) return;
    const idB = await makeChannel(WS_B, { platform: "instagram", platformId: "FC-B" });
    await expect(svc.setChannelDefaultFirstComment(WS_A, idB, "x")).rejects.toThrow();
  });

  it("non-Meta health check marks the channel healthy", async () => {
    if (!TEST_DB) return;
    const id = await makeChannel(WS_A, { platform: "telegram", platformId: "TG", status: "needs_reauth" });
    const status = await svc.runHealthCheck(WS_A, id);
    expect(status).toBe("active");
  });
});

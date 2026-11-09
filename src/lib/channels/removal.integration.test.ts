import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import type { JobHelpers } from "graphile-worker";

let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let crypto: typeof import("@/lib/crypto");
let svc: typeof import("./service");
let app: ReturnType<typeof import("@/server/app").buildApp>;
let cookie: string;
const ws = randomUUID(), otherWs = randomUUID(), user = randomUUID();
const helpers = { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } } as unknown as JobHelpers;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.ENCRYPTION_KEY = "removal-test-encryption-key-at-least-32-characters";
  process.env.JWT_SECRET = "removal-test-jwt-secret-at-least-32-characters";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "removal-test-cron-secret-at-least-32-characters";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  crypto = await import("@/lib/crypto");
  svc = await import("./service");
  app = (await import("@/server/app")).buildApp();
  await db.insert(s.users).values({ id: user, email: `${user}@test.local` });
  cookie = `session=${await (await import("@/lib/auth")).signSession(user, ws)}`;
});

afterEach(() => vi.restoreAllMocks());

beforeEach(async () => {
  await db.delete(s.workspaces).where(inArray(s.workspaces.id, [ws, otherWs]));
  await db.insert(s.workspaces).values([ws, otherWs].map(id => ({ id, name: "Removal", slug: id })));
  await db.insert(s.workspaceMembers).values({ workspace_id: ws, user_id: user, role: "owner" });
});

afterAll(async () => {
  await db.delete(s.workspaces).where(inArray(s.workspaces.id, [ws, otherWs]));
  await db.delete(s.users).where(eq(s.users.id, user));
  await (await import("@/lib/queue/client")).closeQueue();
  await db.$client.end();
});

async function channel(workspaceId = ws, sourceId?: string) {
  const [row] = await db.insert(s.channels).values({
    workspace_id: workspaceId, platform: "instagram", platform_id: randomUUID(),
    token_encrypted: crypto.encryptTokens({ access_token: "page-token", messaging_token: "messaging-token", refresh_token: "refresh-token", user_access_token: "user-token" }),
    webhook_secret: "webhook", status: "active", source_id: sourceId,
    token_expires_at: new Date(), messaging_token_expires_at: new Date(), data_access_expires_at: new Date(),
  }).returning();
  await db.insert(s.insightConnections).values({ workspace_id: workspaceId, channel_id: row.id, platform: row.platform,
    collection_mode: "on", claim_token: randomUUID(), claim_until: new Date(Date.now() + 60000) });
  return row;
}

async function expectRemoved(id: string) {
  const row = await db.query.channels.findFirst({ where: eq(s.channels.id, id) });
  expect(row).toMatchObject({ status: "disabled", token_encrypted: "", token_expires_at: null, messaging_token_expires_at: null, data_access_expires_at: null });
  expect(row?.deleted_at).toBeInstanceOf(Date);
  expect(() => crypto.decryptTokens(row!.token_encrypted)).toThrow();
  expect(await db.query.insightConnections.findFirst({ where: eq(s.insightConnections.channel_id, id) }))
    .toMatchObject({ collection_mode: "off", reason: "collection_off", claim_token: null, claim_until: null });
  expect(await svc.getChannel(ws, id)).toBeUndefined();
  expect((await svc.listChannels({ workspaceId: ws })).items.map(c => c.id)).not.toContain(id);
}

describe("channel removal", () => {
  it.each(["service", "dashboard", "rest"])("%s finishes removal and preserves other channels", async path => {
    const own = await channel();
    const other = await channel(otherWs);
    if (path === "service") await svc.deleteChannel(ws, own.id);
    else {
      const res = await app.request(path === "dashboard" ? `/channels/${own.id}/remove` : `/api/v1/channels/${own.id}`, {
        method: path === "dashboard" ? "POST" : "DELETE", headers: { cookie },
      });
      expect(res.status).toBe(path === "dashboard" ? 303 : 204);
    }
    await expectRemoved(own.id);
    expect(await db.query.channels.findFirst({ where: eq(s.channels.id, other.id) })).toEqual(other);
    expect(await db.query.insightConnections.findFirst({ where: eq(s.insightConnections.channel_id, other.id) })).toMatchObject({ collection_mode: "on" });
    expect((await app.request(`/api/v1/channels/${own.id}`, { headers: { cookie } })).status).toBe(404);
    expect((await app.request(`/api/v1/channels/${own.id}/posts`, { headers: { cookie } })).status).toBe(404);
    expect((await app.request(`/api/v1/channels/${own.id}`, { method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ status: "active" }) })).status).toBe(404);
    const list = await (await app.request("/api/v1/channels", { headers: { cookie } })).json();
    expect(list.data.map((c: {id: string}) => c.id)).not.toContain(own.id);
  });

  it("keeps the source and sibling usable after removing one derived channel", async () => {
    const [source] = await db.insert(s.accountSources).values({ workspace_id: ws, provider: "meta", kind: "user", provider_account_id: "master",
      token_encrypted: crypto.encryptTokens({ access_token: "master-token" }) }).returning();
    const own = await channel(ws, source.id), sibling = await channel(ws, source.id);
    await svc.deleteChannel(ws, own.id);
    await expectRemoved(own.id);
    expect(await db.query.accountSources.findFirst({ where: eq(s.accountSources.id, source.id) })).toEqual(source);
    const { resolveInsightCredential } = await import("@/lib/insights/credentials");
    expect(await resolveInsightCredential({ workspaceId: ws, channelId: own.id }, "facebook")).toBeNull();
    expect(await resolveInsightCredential({ workspaceId: ws, channelId: sibling.id }, "facebook")).toMatchObject({ token: "master-token" });
  });

  it("does not dispatch a queued delivery after removal", async () => {
    const own = await channel();
    const key = randomUUID();
    await db.insert(s.outboundDeliveries).values({ delivery_key: key, workspace_id: ws, channel_id: own.id, task_name: "outgoing-comment", payload: {}, status: "pending" });
    await svc.deleteChannel(ws, own.id);
    const send = vi.fn();
    const { runDelivery } = await import("@/lib/workers/delivery");
    await expect(runDelivery({ channelId: own.id, deliveryKey: key, taskName: "outgoing-comment", payload: {}, helpers, send, onSent: vi.fn() })).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps a removed channel disconnected after health updates", async () => {
    const own = await channel();
    await svc.deleteChannel(ws, own.id);
    const health = await import("./health");
    await health.markChannelHealthy(own.id);
    await health.markChannelNeedsReauth(own.id, "Refresh unavailable");
    await expectRemoved(own.id);
  });

  it.each(["worker", "messaging", "publish", "on-demand"])("keeps removal final when %s refresh finishes afterwards", async path => {
    const own = await channel();
    const refreshToken = vi.fn(async () => {
      await svc.deleteChannel(ws, own.id);
      return { access_token: "fresh-token" };
    });
    if (path === "worker") {
      const registry = await import("./refresh-provider");
      const provider = (await import("@/lib/platforms/registry")).getProvider("instagram");
      vi.spyOn(provider, "requiresTokenRefresh").mockReturnValue(true);
      vi.spyOn(provider, "refreshToken").mockImplementation(refreshToken);
      vi.spyOn(registry, "getTokenRefreshProvider").mockReturnValue(provider);
      await (await import("@/lib/workers/token-refresh-worker")).processTokenRefresh({ channelId: own.id }, helpers);
    } else if (path === "messaging") {
      const registry = await import("@/lib/platforms/registry");
      const provider = registry.getProvider("instagram");
      vi.spyOn(provider, "refreshMessagingToken").mockImplementation(async () => {
        await svc.deleteChannel(ws, own.id);
        return { token: "fresh-message-token", expiresAt: 2000000000 };
      });
      vi.spyOn(registry, "getProvider").mockReturnValue(provider);
      await (await import("@/lib/workers/token-refresh-worker")).processTokenRefresh({ channelId: own.id, kind: "messaging" }, helpers);
    } else if (path === "publish") {
      await db.delete(s.insightConnections).where(eq(s.insightConnections.channel_id, own.id));
      await db.update(s.channels).set({ platform: "youtube" }).where(eq(s.channels.id, own.id));
      await db.insert(s.insightConnections).values({ workspace_id: ws, channel_id: own.id, platform: "youtube", collection_mode: "on" });
      const registry = await import("@/lib/providers");
      const provider = registry.getProvider("youtube");
      vi.spyOn(provider, "refreshToken").mockImplementation(async () => {
        await svc.deleteChannel(ws, own.id);
        return { accessToken: "fresh-token" };
      });
      await (await import("./token-refresh")).processTokenRefresh({ channelId: own.id }, helpers);
    } else {
      const provider = (await import("@/lib/platforms/registry")).getProvider("instagram");
      vi.spyOn(provider, "requiresTokenRefresh").mockReturnValue(true);
      vi.spyOn(provider, "refreshToken").mockImplementation(refreshToken);
      await (await import("./refresh-if-near-expiry")).refreshIfNearExpiry(own.id, provider, { access_token: "old", expires_at: 1 });
    }
    await expectRemoved(own.id);
  });

  it("source sync preserves removed channels while updating siblings", async () => {
    const [source] = await db.insert(s.accountSources).values({ workspace_id: ws, provider: "meta", kind: "user", provider_account_id: "sync-master",
      token_encrypted: crypto.encryptTokens({ access_token: "master-token" }) }).returning();
    const own = await channel(ws, source.id), sibling = await channel(ws, source.id);
    await svc.deleteChannel(ws, own.id);
    const removed = await db.query.channels.findFirst({ where: eq(s.channels.id, own.id) });
    const { upsertChannels } = await import("./upsert");
    for (let sync = 0; sync < 2; sync++) {
      expect(await upsertChannels(ws, "instagram", [own, sibling].map(row => ({
        platformId: row.platform_id, displayName: "Synced", tokens: { access_token: "fresh-page-token" },
      })), { sourceId: source.id })).toEqual({ recoveredChannelIds: [] });
      expect(await db.query.channels.findFirst({ where: eq(s.channels.id, own.id) })).toEqual(removed);
      await expectRemoved(own.id);
      const updated = await db.query.channels.findFirst({ where: eq(s.channels.id, sibling.id) });
      expect(updated).toMatchObject({ status: "active", display_name: "Synced", source_id: source.id });
      expect(crypto.decryptTokens(updated!.token_encrypted).access_token).toBe("fresh-page-token");
    }
    expect(await db.query.accountSources.findFirst({ where: eq(s.accountSources.id, source.id) })).toEqual(source);
  });

  it("keeps removal final when YouTube access refresh finishes afterwards", async () => {
    const own = await channel();
    const client = await import("@/lib/youtube/client");
    vi.spyOn(client, "refreshGoogleAccessToken").mockImplementation(async () => {
      await svc.deleteChannel(ws, own.id);
      return { accessToken: "fresh-google-token", expiresAt: 2000000000 };
    });
    const { freshYouTubeAccessToken } = await import("@/lib/youtube/poll");
    await freshYouTubeAccessToken({ ...own, token_encrypted: crypto.encryptTokens({ access_token: "old", refresh_token: "refresh", expires_at: 1 }) });
    await expectRemoved(own.id);
  });

  it("keeps removal final when an IG-Login merge has read the channel", async () => {
    const own = await channel();
    const transaction = db.transaction.bind(db);
    const transactionSpy = vi.spyOn(db, "transaction").mockImplementation((callback, config) => {
      transactionSpy.mockRestore();
      return transaction(async tx => {
        const find = tx.query.channels.findFirst.bind(tx.query.channels);
        vi.spyOn(tx.query.channels, "findFirst").mockImplementationOnce((...args) => {
          const query = find(...args);
          const execute = query.execute.bind(query);
          vi.spyOn(query, "execute").mockImplementationOnce(async () => {
            const live = await execute();
            await svc.deleteChannel(ws, own.id);
            return live;
          });
          return query;
        });
        return callback(tx);
      }, config);
    });
    const { upsertChannels } = await import("./upsert");
    expect(await upsertChannels(ws, "instagram", [{ platformId: own.platform_id, displayName: "IG", tokens: { access_token: "" } }], {
      augmentMessagingToken: { token: "IGQW_new", expiresAt: new Date("2030-01-01") },
    })).toEqual({ recoveredChannelIds: [] });
    await expectRemoved(own.id);
  });

  it("leaves foreign channels unchanged when removal is requested", async () => {
    const other = await channel(otherWs);
    await expect(svc.deleteChannel(ws, other.id)).rejects.toThrow();
    for (const [url, method] of [[`/channels/${other.id}/remove`, "POST"], [`/api/v1/channels/${other.id}`, "DELETE"]]) {
      expect((await app.request(url, { method, headers: { cookie } })).status).toBe(404);
    }
    expect(await db.query.channels.findFirst({ where: eq(s.channels.id, other.id) })).toEqual(other);
    expect(await db.query.insightConnections.findFirst({ where: eq(s.insightConnections.channel_id, other.id) })).toMatchObject({ collection_mode: "on" });
  });
});

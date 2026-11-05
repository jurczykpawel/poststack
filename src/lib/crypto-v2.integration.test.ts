import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { reference } from "../../tests/helpers/versioned-values";

const key = "reference-current-passphrase-00000000";
const other = "reference-previous-passphrase-0000000";
const workspaceId = "c0ffee02-0000-4000-8000-000000000c22";
let db: typeof import("./db").db;
let schema: typeof import("@/db/schema");
let config: typeof import("./settings/config");
beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL!;
  process.env.ENCRYPTION_KEY = key;
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  ({ db } = await import("./db"));
  schema = await import("@/db/schema");
  config = await import("./settings/config");
  const { seedWorkspace } = await import("../../tests/helpers/workspace");
  await seedWorkspace(db, schema, { id: workspaceId, slug: "versioned-reader" });
});
afterEach(async () => {
  vi.unstubAllEnvs(); config.invalidateConfigCache();
  await db.delete(schema.instanceSettings).where(eq(schema.instanceSettings.key, "META_APP_SECRET"));
});
afterAll(async () => {
  await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
  await db.$client.end();
});

describe("versioned stored values", () => {
  it("loads a setting with its original key and reports unavailable values", async () => {
    const context = ["instance", "instance_settings.value_encrypted", "META_APP_SECRET"];
    await db.insert(schema.instanceSettings).values({ key: "META_APP_SECRET", value_encrypted: reference("example", key, context) });
    expect(await config.getConfig("META_APP_SECRET")).toBe("example");
    vi.stubEnv("ENCRYPTION_KEY", other); config.invalidateConfigCache();
    await expect(config.getConfig("META_APP_SECRET")).rejects.toThrow("Encryption key unavailable");
    vi.stubEnv("ENCRYPTION_KEY_PREVIOUS", JSON.stringify([key]));
    expect(await config.getConfig("META_APP_SECRET")).toBe("example");
    await db.update(schema.instanceSettings).set({ value_encrypted: reference("different", key, ["instance", "instance_settings.value_encrypted", "AI_API_KEY"]) }).where(eq(schema.instanceSettings.key, "META_APP_SECRET"));
    config.invalidateConfigCache();
    await expect(config.getConfig("META_APP_SECRET")).rejects.toThrow();
  });
  it("loads endpoint values and keeps each field's context", async () => {
    const endpoints = await import("./webhooks/endpoints");
    const created = await endpoints.createEndpoint(workspaceId, { url: "https://example.com/hook" });
    const ctx = (field: string) => [`ws:${workspaceId}`, `webhook_endpoints.${field}`, created.id];
    const stored = reference("current", key, ctx("secret"));
    await db.update(schema.webhookEndpoints).set({ secret: stored, secret_secondary: reference("previous", key, ctx("secret_secondary")), custom_headers_encrypted: reference('{"X-Example":"value"}', key, ctx("custom_headers_encrypted")) }).where(eq(schema.webhookEndpoints.id, created.id));
    expect((await endpoints.listEndpoints(workspaceId))[0]).toMatchObject({ secret: "current", secret_secondary: "previous", headers: { "X-Example": "value" } });
    await db.update(schema.webhookEndpoints).set({ secret_secondary: stored }).where(eq(schema.webhookEndpoints.id, created.id));
    await expect(endpoints.listEndpoints(workspaceId)).rejects.toThrow();
  });
  it("reads a stored channel using its selected identity", async () => {
    const { decryptChannelToken } = await import("./channels/tokens");
    const context = [`ws:${workspaceId}`, "channels.token_encrypted", "facebook", "example-page"] as const;
    const [channel] = await db.insert(schema.channels).values({ workspace_id: workspaceId, platform: "facebook", platform_id: "example-page", webhook_secret: "example", token_encrypted: reference('{"access_token":"example"}', key, context) }).returning();
    expect(decryptChannelToken(channel.token_encrypted, context)).toEqual({ access_token: "example" });
    vi.stubEnv("ENCRYPTION_KEY", other);
    expect(() => decryptChannelToken(channel.token_encrypted, context)).toThrow("Encryption key unavailable");
  });
});

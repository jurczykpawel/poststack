import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createHash } from "crypto";
import { inArray } from "drizzle-orm";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { workspaces, channels, apiKeys, users, workspaceMembers } from "@/db/schema";
import type { Hono } from "hono";

const TEST_DB = process.env.TEST_DATABASE_URL;
const LIMITED_KEY = "sk_live_mcp_integration_limited_0123456789";
const OTHER_KEY = "sk_live_mcp_integration_other_0123456789ab";

let db: typeof import("@/lib/db").db;
let app: Hono;
let mcpOperations: typeof import("@/lib/mcp/operations").mcpOperations;
let openApiSpec: typeof import("@/lib/api/openapi").openApiSpec;
let encryptTokens: typeof import("@/lib/crypto").encryptTokens;

const WS_A = "eeeeeeee-0000-0000-0000-00000000000a";
const WS_B = "eeeeeeee-0000-0000-0000-00000000000b";
const CH_A = "eeeeeeee-0000-0000-0000-0000000000c1";
const CH_B = "eeeeeeee-0000-0000-0000-0000000000c2";
const USER_A = "eeeeeeee-0000-0000-0000-0000000000f1";
let sessionCookie: string;

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  ({ mcpOperations } = await import("@/lib/mcp/operations"));
  ({ openApiSpec } = await import("@/lib/api/openapi"));
  ({ encryptTokens } = await import("@/lib/crypto"));
  const { buildApp } = await import("../app");
  app = buildApp();
  const { signSession } = await import("@/lib/auth");
  const { BRAND } = await import("@/lib/brand");
  sessionCookie = `${BRAND.cookieName}=${await signSession(USER_A, WS_A)}`;
});

beforeEach(async () => {
  if (!TEST_DB) return;
  const encrypt = encryptTokens;
  await db.delete(workspaces).where(inArray(workspaces.id, [WS_A, WS_B]));
  await db.delete(users).where(inArray(users.id, [USER_A]));
  await db.insert(users).values({ id: USER_A, email: `mcp-${USER_A}@test.local` });
  await db.insert(workspaces).values([{ id: WS_A, name: "A", slug: `a-${WS_A}` }, { id: WS_B, name: "B", slug: `b-${WS_B}` }]);
  await db.insert(channels).values([
    { id: CH_A, workspace_id: WS_A, platform: "facebook", platform_id: "MCP_PAGE_A", display_name: "Page A", token_encrypted: encrypt({ access_token: "a" }), webhook_secret: "wh", status: "active" },
    { id: CH_B, workspace_id: WS_B, platform: "facebook", platform_id: "MCP_PAGE_B", display_name: "Page B", token_encrypted: encrypt({ access_token: "b" }), webhook_secret: "wh", status: "active" },
  ]);
  await db.insert(workspaceMembers).values({ workspace_id: WS_A, user_id: USER_A, role: "owner" });
  await db.insert(apiKeys).values([
    { workspace_id: WS_A, name: "limited", key_hash: createHash("sha256").update(LIMITED_KEY).digest("hex"), key_prefix: "sk_live_mcp_lim", scopes: ["channels:read"] },
    { workspace_id: WS_B, name: "other", key_hash: createHash("sha256").update(OTHER_KEY).digest("hex"), key_prefix: "sk_live_mcp_oth", scopes: [] },
  ]);
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(workspaces).where(inArray(workspaces.id, [WS_A, WS_B]));
  await db.delete(users).where(inArray(users.id, [USER_A]));
  await db.$client.end();
});

/** Official SDK client speaking Streamable HTTP to the real app (no network). */
async function connect(key: string, query = ""): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`http://localhost/mcp${query}`), {
    requestInit: { headers: { authorization: `Bearer ${key}` } },
    fetch: async (url, init) => app.request(String(url), init),
  });
  const client = new Client({ name: "mcp-integration-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

const text = (result: Awaited<ReturnType<Client["callTool"]>>) => (result.content as Array<{ text: string }>)[0].text;
const rpc = (headers: Record<string, string>, method = "POST") => app.request("/mcp", {
  method, headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
  body: method === "POST" ? JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) : undefined,
});

describe.skipIf(!TEST_DB)("/mcp (real app + Postgres)", () => {
  it("rejects requests without a valid API key with 401 + WWW-Authenticate, including a valid dashboard session", async () => {
    // The same session is accepted by the API itself, so the 401 below is the MCP boundary's decision.
    expect((await app.request("/api/v1/channels", { headers: { cookie: sessionCookie } })).status).toBe(200);
    const attempts: Array<Record<string, string>> = [{}, { authorization: "Bearer sk_live_nope" }, { cookie: sessionCookie }, { authorization: "Basic abc" }];
    for (const headers of attempts) {
      const res = await rpc(headers);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
    }
  });

  it("is stateless: GET/DELETE return 405", async () => {
    expect((await rpc({ authorization: `Bearer ${LIMITED_KEY}` }, "GET")).status).toBe(405);
    expect((await rpc({ authorization: `Bearer ${LIMITED_KEY}` }, "DELETE")).status).toBe(405);
  });

  it("initialize → tools/list shows only operations the key's scopes allow", async () => {
    const client = await connect(LIMITED_KEY);
    expect(client.getServerVersion()?.name).toBeTruthy();
    const { tools } = await client.listTools();
    const expected = mcpOperations(openApiSpec as never).filter((op) => op.scope === "channels:read").map((op) => op.name);
    expect(tools.map((t) => t.name).sort()).toEqual(expected.sort());
    expect(tools.map((t) => t.name)).toContain("get_channels");
    expect(tools.find((t) => t.name === "get_channels")?.annotations?.readOnlyHint).toBe(true);
    await client.close();
  });

  it("tools/call goes through the real API with the caller's key and workspace", async () => {
    const client = await connect(LIMITED_KEY);
    const list = await client.callTool({ name: "get_channels", arguments: {} });
    expect(list.isError).toBe(false);
    const body = JSON.parse(text(list)) as { data: Array<{ id: string }>; error: null };
    expect(body.error).toBeNull();
    expect(body.data.map((c) => c.id)).toEqual([CH_A]);

    // Workspace isolation is the API's: another workspace's channel is a 404 error result.
    const foreign = await client.callTool({ name: "get_channels_by_channel_id", arguments: { channelId: CH_B } });
    expect(foreign.isError).toBe(true);
    expect(JSON.parse(text(foreign)).error.code).toBe("not_found");
    await client.close();
  });

  it("an operation outside the key's scope is neither listed nor callable", async () => {
    const client = await connect(LIMITED_KEY);
    const res = await client.callTool({ name: "delete_channels_by_channel_id", arguments: { channelId: CH_A } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/not permitted/);
    const [row] = await db.select({ id: channels.id }).from(channels).where(inArray(channels.id, [CH_A]));
    expect(row?.id).toBe(CH_A);
    await client.close();
  });

  it("compact mode: search_operations + call_operation, both limited to the key's scopes", async () => {
    const client = await connect(LIMITED_KEY, "?mode=compact");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["call_operation", "search_operations"]);

    const found = JSON.parse(text(await client.callTool({ name: "search_operations", arguments: { query: "channel" } }))) as Array<{ operationId: string }>;
    expect(found.map((o) => o.operationId)).toContain("get_channels");
    expect(found.map((o) => o.operationId)).not.toContain("patch_channels_by_channel_id");

    const call = await client.callTool({ name: "call_operation", arguments: { operationId: "get_channels", params: {} } });
    expect(call.isError).toBe(false);
    expect(JSON.parse(text(call)).data.map((c: { id: string }) => c.id)).toEqual([CH_A]);

    const denied = await client.callTool({ name: "call_operation", arguments: { operationId: "patch_channels_by_channel_id", params: { channelId: CH_A, body: {} } } });
    expect(denied.isError).toBe(true);
    await client.close();
  });

  it("an empty-scope key sees workspace operations but no instance_* ones", async () => {
    const client = await connect(OTHER_KEY);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("post_tags");
    expect(names).not.toContain("get_settings_ai");
    await client.close();
  });
});

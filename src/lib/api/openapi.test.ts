import { describe, it, expect, beforeAll } from "vitest";

let v1: typeof import("@/server/routes/v1").v1;
let openApiSpec: typeof import("./openapi").openApiSpec;

const EXPECTED_API_KEY_SCOPES = [
  "channels:read", "channels:write",
  "conversations:read", "conversations:write",
  "contacts:read", "contacts:write",
  "rules:read", "rules:write",
  "sequences:read", "sequences:write",
  "tags:read", "tags:write",
  "settings:read", "settings:write",
  "sources:read", "sources:write",
  "webhooks:read", "webhooks:write",
  "stats:read",
  "content:read", "content:write",
  "posts:read", "posts:write",
  "brands:read", "brands:write",
  "media:write",
] as const;

beforeAll(async () => {
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5433/test";
  ({ v1 } = await import("@/server/routes/v1"));
  ({ openApiSpec } = await import("./openapi"));
});

/** Every method+path the router registers, with Hono's `:param` rewritten to OpenAPI `{param}`. */
function registeredRoutes(): Array<{ method: string; oapiPath: string }> {
  const seen = new Set<string>();
  const out: Array<{ method: string; oapiPath: string }> = [];
  for (const r of (v1 as unknown as { routes: Array<{ method: string; path: string }> }).routes) {
    if (r.method === "ALL") continue; // mounted middleware, not an endpoint
    const oapiPath = r.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
    const key = `${r.method} ${oapiPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ method: r.method.toLowerCase(), oapiPath });
  }
  return out;
}

describe("OpenAPI spec ↔ v1 router parity", () => {
  it("documents every registered v1 route", () => {
    const paths = openApiSpec.paths as Record<string, Record<string, unknown>>;
    const missing = registeredRoutes()
      .filter(({ method, oapiPath }) => !paths[oapiPath]?.[method])
      .map(({ method, oapiPath }) => `${method.toUpperCase()} ${oapiPath}`);
    expect(missing).toEqual([]);
  });

  it("documents /health at its real path (/api/health) and raw shape", () => {
    const health = (openApiSpec.paths as unknown as Record<string, { servers?: Array<{ url: string }>; get?: { responses: Record<string, { content: Record<string, { schema: { properties: Record<string, unknown> } }> }> } }>)["/health"];
    expect(health?.get).toBeTruthy();
    // Health lives at /api/health, NOT /api/v1/health — override the server for this path.
    expect(health!.servers?.[0]?.url).toBe("/api");
    const schema = health!.get!.responses["200"].content["application/json"].schema;
    expect(schema.properties).toHaveProperty("status");
    expect(schema.properties).toHaveProperty("timestamp");
    // The handler returns a raw object, not the { data, error } envelope.
    expect(schema.properties).not.toHaveProperty("data");
  });

  it("Channel schema documents platform_id (A14 — handler returns it)", () => {
    const channel = (openApiSpec.components.schemas as unknown as Record<string, { properties: Record<string, unknown> }>).Channel;
    expect(channel.properties).toHaveProperty("platform_id");
  });

  it("Message.status enum includes held and expired", () => {
    const msg = (openApiSpec.components.schemas as unknown as Record<string, { properties: { status: { enum: string[] } } }>).Message;
    expect(msg.properties.status.enum).toEqual(expect.arrayContaining(["held", "expired"]));
  });

  // the AutoReplyRule schema is the create/patch REQUEST contract (and the read response).
  // It must mirror the writable zod enum on create/patch. SEQTRIGGER1 shipped trigger-driven
  // enrollment, so `sequence` is now a writable response_type (it requires response_config.sequence_id)
  // and the spec advertises it alongside the others.
  it("AutoReplyRule.response_type enum mirrors the writable zod enum (incl. `sequence`)", () => {
    const rule = (openApiSpec.components.schemas as unknown as Record<string, { properties: { response_type: { enum: string[] } } }>).AutoReplyRule;
    expect(rule.properties.response_type.enum).toEqual(
      expect.arrayContaining(["text", "random_text", "none", "ai_rephrase", "follow_gate", "sequence"]),
    );
  });

  it("documents the exact API-key scope catalog on read and create schemas", () => {
    const apiKey = (openApiSpec.components.schemas as unknown as Record<string, {
      properties: { scopes: { items: { enum?: readonly string[] } } };
    }>).ApiKey;
    const paths = openApiSpec.paths as unknown as Record<string, {
      post?: { requestBody?: { content: { "application/json": { schema: {
        required: string[];
        properties: { scopes: { minItems?: number; uniqueItems?: boolean; items: { enum?: readonly string[] } } };
      } } } } };
    }>;
    const createSchema = paths["/api-keys"].post?.requestBody?.content["application/json"].schema;
    const createScopes = createSchema?.properties.scopes;

    expect(apiKey.properties.scopes.items.enum).toEqual(EXPECTED_API_KEY_SCOPES);
    expect(createScopes?.items.enum).toEqual(EXPECTED_API_KEY_SCOPES);
    expect(createSchema?.required).toEqual(expect.arrayContaining(["name", "scopes"]));
    expect(createScopes).toMatchObject({ minItems: 1, uniqueItems: true });
  });

  it("documents API-key administration as a dashboard-session operation", () => {
    const schemes = openApiSpec.components.securitySchemes as unknown as Record<string, {
      type: string;
      in?: string;
      name?: string;
    }>;
    expect(schemes.SessionCookie).toMatchObject({
      type: "apiKey",
      in: "cookie",
      name: "session",
    });

    const paths = openApiSpec.paths as unknown as Record<string, Record<string, {
      security?: Array<Record<string, never[]>>;
      responses: Record<string, unknown>;
    }>>;
    for (const [path, method] of [
      ["/api-keys", "get"],
      ["/api-keys", "post"],
      ["/api-keys/{keyId}", "delete"],
    ] as const) {
      expect(paths[path][method].security).toEqual([{ SessionCookie: [] }]);
      expect(paths[path][method].responses).toHaveProperty("403");
    }
  });

  it.each([
    ["GET", "/content", "content:read"],
    ["POST", "/content", "content:write"],
    ["GET", "/content/{contentId}", "content:read"],
    ["PATCH", "/content/{contentId}", "content:write"],
    ["DELETE", "/content/{contentId}", "content:write"],
    ["GET", "/posts", "posts:read"],
    ["POST", "/posts", "posts:write"],
    ["GET", "/posts/{postId}", "posts:read"],
    ["PATCH", "/posts/{postId}", "posts:write"],
    ["DELETE", "/posts/{postId}", "posts:write"],
    ["POST", "/posts/{postId}/publish", "posts:write"],
    ["GET", "/brands", "brands:read"],
    ["POST", "/brands", "brands:write"],
    ["GET", "/brands/{brandKey}/channels", "brands:read"],
    ["PATCH", "/brands/{brandKey}", "brands:write"],
    ["DELETE", "/brands/{brandKey}", "brands:write"],
    ["POST", "/media", "media:write"],
    ["GET", "/channels", "channels:read"],
    ["POST", "/channels/telegram/connect", "channels:write"],
    ["GET", "/contacts", "contacts:read"],
    ["POST", "/contacts", "contacts:write"],
    ["GET", "/conversations", "conversations:read"],
    ["GET", "/rules", "rules:read"],
    ["POST", "/rules", "rules:write"],
    ["GET", "/approvals", "conversations:read"],
    ["POST", "/approvals/{approvalId}/approve", "conversations:write"],
    ["POST", "/approvals/{approvalId}/reject", "conversations:write"],
    ["POST", "/channels/connect-token", "channels:write"],
    ["GET", "/sources", "sources:read"],
    ["POST", "/sources", "sources:write"],
    ["DELETE", "/sources/{sourceId}", "sources:write"],
    ["POST", "/sources/{sourceId}/sync", "sources:write"],
    ["GET", "/channels/{channelId}", "channels:read"],
    ["PATCH", "/channels/{channelId}", "channels:write"],
    ["DELETE", "/channels/{channelId}", "channels:write"],
    ["POST", "/channels/{channelId}/drain", "channels:write"],
    ["POST", "/channels/{channelId}/gmail-filter", "channels:write"],
    ["GET", "/channels/{channelId}/posts", "channels:read"],
    ["GET", "/contacts/{contactId}", "contacts:read"],
    ["PATCH", "/contacts/{contactId}", "contacts:write"],
    ["DELETE", "/contacts/{contactId}", "contacts:write"],
    ["GET", "/conversations/{conversationId}", "conversations:read"],
    ["PATCH", "/conversations/{conversationId}", "conversations:write"],
    ["GET", "/conversations/{conversationId}/messages", "conversations:read"],
    ["POST", "/conversations/{conversationId}/messages", "conversations:write"],
    ["GET", "/rules/{ruleId}", "rules:read"],
    ["PATCH", "/rules/{ruleId}", "rules:write"],
    ["DELETE", "/rules/{ruleId}", "rules:write"],
    ["GET", "/sequences", "sequences:read"],
    ["POST", "/sequences", "sequences:write"],
    ["GET", "/sequences/{sequenceId}", "sequences:read"],
    ["PATCH", "/sequences/{sequenceId}", "sequences:write"],
    ["DELETE", "/sequences/{sequenceId}", "sequences:write"],
    ["POST", "/sequences/{sequenceId}/enroll", "sequences:write"],
    ["DELETE", "/sequences/{sequenceId}/enrollments/{enrollmentId}", "sequences:write"],
    ["GET", "/stats/response-times", "stats:read"],
    ["GET", "/audit-log", "settings:read"],
    ["POST", "/messages/prune", "settings:write"],
    ["POST", "/webhook-events/prune", "settings:write"],
    ["GET", "/workspace", "settings:read"],
    ["PATCH", "/workspace", "settings:write"],
    ["GET", "/license", "settings:read"],
    ["POST", "/license", "settings:write"],
    ["DELETE", "/license", "settings:write"],
    ["GET", "/tags", "tags:read"],
    ["POST", "/tags", "tags:write"],
    ["PATCH", "/tags/{tagId}", "tags:write"],
    ["DELETE", "/tags/{tagId}", "tags:write"],
    ["GET", "/webhooks", "webhooks:read"],
    ["POST", "/webhooks", "webhooks:write"],
    ["GET", "/webhooks/{webhookId}", "webhooks:read"],
    ["PATCH", "/webhooks/{webhookId}", "webhooks:write"],
    ["DELETE", "/webhooks/{webhookId}", "webhooks:write"],
    ["POST", "/webhooks/{webhookId}/rotate-secret", "webhooks:write"],
  ] as const)("documents %s %s as requiring %s", (method, path, requiredScope) => {
    const paths = openApiSpec.paths as unknown as Record<string, Record<string, { "x-required-scope"?: string }>>;
    expect(paths[path][method.toLowerCase()]["x-required-scope"]).toBe(requiredScope);
  });

  it("documents the additional permission needed to embed posts in content detail", () => {
    const paths = openApiSpec.paths as unknown as Record<string, Record<string, { description?: string }>>;
    expect(paths["/content/{contentId}"].get.description).toContain("posts:read");
  });
});

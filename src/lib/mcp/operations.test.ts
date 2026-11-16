import { describe, it, expect, beforeAll } from "vitest";
import { buildApiRequest, mcpOperations, scopeAllows, searchOperations, type OpenApiDocument } from "./operations";

const sample: OpenApiDocument = {
  servers: [{ url: "/api/v1" }],
  components: {
    schemas: {
      Tag: { type: "object", properties: { name: { type: "string" }, parent: { $ref: "#/components/schemas/Tag" } } },
    },
    parameters: { Limit: { name: "limit", in: "query", schema: { type: "integer" } } },
  },
  paths: {
    "/tags": {
      get: { operationId: "listTags", "x-required-scope": "tags:read", summary: "List tags", tags: ["Tags"], parameters: [{ name: "limit", in: "query", schema: { type: "integer" } }] },
      post: { operationId: "createTag", "x-required-scope": "tags:write", summary: "Create a tag", description: "Long text", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/Tag" } } } } },
    },
    "/tags/{tagId}": {
      parameters: [{ name: "tagId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
      delete: { operationId: "deleteTag", "x-required-scope": "tags:write", summary: "Delete a tag" },
      patch: { operationId: "renameTag", "x-required-scope": "tags:write", summary: "Rename", "x-mcp": { description: "Agent text", destructive: true } },
    },
    "/upload": { post: { operationId: "upload", "x-required-scope": "media:write", requestBody: { content: { "application/octet-stream": { schema: { type: "string" } } } } } },
    "/hidden": { get: { operationId: "hidden", "x-required-scope": "tags:read", "x-mcp": { exclude: true } } },
    "/session-only": { get: { operationId: "sessionOnly", "x-required-scope": "settings:read", security: [{ SessionCookie: [] }] } },
    "/public": { get: { operationId: "public", security: [] } },
    "/ai": { get: { operationId: "aiSettings", "x-required-scope": "instance_ai:read" } },
  },
};

describe("mcpOperations (sample spec)", () => {
  const ops = mcpOperations(sample);
  const byName = Object.fromEntries(ops.map((o) => [o.name, o]));

  it("derives tools from operations and drops excluded, session-only, unscoped and binary-only ones", () => {
    expect(ops.map((o) => o.name).sort()).toEqual(["aiSettings", "createTag", "deleteTag", "listTags", "renameTag"]);
  });

  it("builds inputSchema from path-item + operation params and a resolved JSON body", () => {
    expect(byName.listTags.inputSchema).toEqual({ type: "object", properties: { limit: { type: "integer" } }, additionalProperties: false });
    expect(byName.deleteTag.inputSchema).toEqual({
      type: "object", properties: { tagId: { type: "string", format: "uuid" } }, required: ["tagId"], additionalProperties: false,
    });
    const props = byName.createTag.inputSchema.properties as Record<string, unknown>;
    expect(props.body).toEqual({ type: "object", properties: { name: { type: "string" }, parent: {} } }); // self-reference cut
    expect(byName.createTag.inputSchema.required).toEqual(["body"]);
    expect(JSON.stringify(ops)).not.toContain("$ref");
  });

  it("maps annotations and x-mcp overrides", () => {
    expect(byName.listTags.annotations).toEqual({ title: "List tags", readOnlyHint: true });
    expect(byName.deleteTag.annotations).toEqual({ title: "Delete a tag", readOnlyHint: false, destructiveHint: true });
    expect(byName.createTag.annotations.destructiveHint).toBeUndefined();
    expect(byName.renameTag.annotations.destructiveHint).toBe(true);
    expect(byName.renameTag.description).toBe("Agent text");
    expect(byName.createTag.description).toBe("Create a tag\n\nLong text");
    expect(byName.listTags.path).toBe("/api/v1/tags");
  });

  it("filters by scope like the API (empty = all but instance_*)", () => {
    const visible = (scopes: string[]) => ops.filter((o) => scopeAllows(scopes, o.scope)).map((o) => o.name).sort();
    expect(visible(["tags:read"])).toEqual(["listTags"]);
    expect(visible([])).toEqual(["createTag", "deleteTag", "listTags", "renameTag"]);
    expect(visible(["instance_ai:read"])).toEqual(["aiSettings"]);
  });

  it("compact search matches every word across name/summary/description/tags", () => {
    expect(searchOperations(ops, "tag delete").map((o) => o.name)).toEqual(["deleteTag"]);
    expect(searchOperations(ops, "long").map((o) => o.name)).toEqual(["createTag"]);
    expect(searchOperations(ops, "")).toHaveLength(ops.length);
    expect(searchOperations(ops, "", 2)).toHaveLength(2);
  });

  it("builds the HTTP request: encoded path params, repeated query arrays, JSON body", () => {
    expect(buildApiRequest(byName.deleteTag, { tagId: "a/b" })).toEqual({ path: "/api/v1/tags/a%2Fb" });
    expect(buildApiRequest(byName.listTags, { limit: [1, 2] })).toEqual({ path: "/api/v1/tags?limit=1&limit=2" });
    expect(buildApiRequest(byName.createTag, { body: { name: "x" } })).toEqual({ path: "/api/v1/tags", body: '{"name":"x"}' });
    expect(() => buildApiRequest(byName.deleteTag, {})).toThrow("Missing path parameter: tagId");
  });
});

describe("mcpOperations (this app's spec)", () => {
  let spec: OpenApiDocument;
  beforeAll(async () => {
    process.env.JWT_SECRET ??= "test-secret-at-least-32-characters-long";
    process.env.ENCRYPTION_KEY ??= "0000000000000000000000000000000000000000000000000000000000000001";
    process.env.APP_URL ??= "http://localhost:3000";
    process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5433/test";
    spec = (await import("@/lib/api/openapi")).openApiSpec as unknown as OpenApiDocument;
  });

  it("every operation has a unique operationId usable as an MCP tool name", () => {
    const ids = Object.values(spec.paths).flatMap((item) =>
      ["get", "post", "put", "patch", "delete"].flatMap((m) => item[m] ? [(item[m] as { operationId?: string }).operationId] : []));
    expect(ids.every((id) => typeof id === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every exposed operation declares its path params and yields a self-contained object inputSchema", () => {
    const ops = mcpOperations(spec);
    expect(ops.length).toBeGreaterThan(80);
    for (const op of ops) {
      const props = op.inputSchema.properties as Record<string, unknown>;
      for (const [, name] of op.path.matchAll(/\{(\w+)\}/g)) {
        expect(props[name], `${op.name} declares {${name}}`).toBeTruthy();
        expect(op.inputSchema.required).toContain(name);
      }
      expect(JSON.stringify(op.inputSchema), op.name).not.toContain("$ref");
      if (["POST", "PUT", "PATCH"].includes(op.method) && op.hasBody) expect(props.body, op.name).toMatchObject({});
    }
  });

  it("exposes creator consent in the generated TikTok publish tool", () => {
    const op = mcpOperations(spec).find((o) => o.name === "post_posts_by_post_id_publish");
    expect(op?.inputSchema.properties).toMatchObject({
      body: { properties: { tiktokConsent: {
        type: "boolean",
        description: expect.stringContaining("Agents must set true only after explicit creator confirmation"),
      } } },
    });
    expect(buildApiRequest(op!, { postId: "post", body: { channelId: "channel", tiktokConsent: true } }).body)
      .toBe(JSON.stringify({ channelId: "channel", tiktokConsent: true }));
  });

  it("documents JSON bodies for the editorial write operations agents need", () => {
    const ops = Object.fromEntries(mcpOperations(spec).map((o) => [o.name, o]));
    for (const name of ["post_content", "patch_content_by_content_id", "patch_posts_by_post_id", "post_brands", "patch_brands_by_brand_key"]) {
      expect(ops[name]?.hasBody, name).toBe(true);
    }
    expect(ops.post_webhooks.hasBody).toBe(true);
    expect(ops.post_api_keys).toBeUndefined(); // session-only
    expect(ops.post_messages_prune).toBeUndefined(); // x-mcp exclude
  });
});

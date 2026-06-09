import { describe, it, expect, beforeAll } from "vitest";

let v1: typeof import("@/server/routes/v1").v1;
let openApiSpec: typeof import("./openapi").openApiSpec;

beforeAll(async () => {
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.TOKEN_ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
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

  it("Message.status enum includes held and expired", () => {
    const msg = (openApiSpec.components.schemas as unknown as Record<string, { properties: { status: { enum: string[] } } }>).Message;
    expect(msg.properties.status.enum).toEqual(expect.arrayContaining(["held", "expired"]));
  });

  it("AutoReplyRule.response_type enum includes sequence (returned by reads even though writes reject it)", () => {
    const rule = (openApiSpec.components.schemas as unknown as Record<string, { properties: { response_type: { enum: string[] } } }>).AutoReplyRule;
    expect(rule.properties.response_type.enum).toContain("sequence");
  });
});

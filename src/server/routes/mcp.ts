/**
 * Built-in MCP endpoint (stateless Streamable HTTP). A thin client over this version's OpenAPI spec:
 * tools come from `mcpOperations(openApiSpec)` and every call is an internal request to `/api/v1`
 * with the caller's own API key, so auth, scopes, workspace isolation and limits are the API's.
 *
 * `/mcp` exposes one tool per operation; `/mcp?mode=compact` exposes `search_operations` + `call_operation`.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { Server, WebStandardStreamableHTTPServerTransport, type CallToolResult, type Tool } from "@modelcontextprotocol/server";
import { authenticate } from "@/lib/auth";
import { BRAND } from "@/lib/brand";
import { openApiSpec } from "@/lib/api/openapi";
import { APP_VERSION } from "@/lib/telemetry/collect";
import { buildApiRequest, mcpOperations, scopeAllows, searchOperations, type McpOperation, type OpenApiDocument } from "@/lib/mcp/operations";

const OPERATIONS = mcpOperations(openApiSpec as unknown as OpenApiDocument);
/** Client-IP headers the API's rate limiter reads, forwarded so MCP traffic shares the caller's bucket. */
const FORWARDED_HEADERS = ["authorization", "user-agent", "cf-connecting-ip", "x-real-ip", "x-forwarded-for"];

const COMPACT_TOOLS: Tool[] = [
  {
    name: "search_operations",
    description: `Search the ${BRAND.name} API operations this key may call. Every word must match the operation name, path, summary, description or tag; an empty query matches all; at most 20 results. Returns each operation's name and input schema for call_operation.`,
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
    annotations: { title: "Search API operations", readOnlyHint: true },
  },
  {
    name: "call_operation",
    description: "Call an API operation found with search_operations. `params` follows that operation's input schema (path and query parameters by name, JSON request body under `body`).",
    inputSchema: { type: "object", properties: { operationId: { type: "string" }, params: { type: "object" } }, required: ["operationId"], additionalProperties: false },
    annotations: { title: "Call an API operation", readOnlyHint: false },
  },
];

const toolError = (text: string): CallToolResult => ({ content: [{ type: "text", text }], isError: true });
const asTool = (op: McpOperation): Tool => ({ name: op.name, description: op.description, inputSchema: op.inputSchema, annotations: op.annotations });

function unauthorized(): Response {
  return Response.json(
    { jsonrpc: "2.0", error: { code: -32001, message: `Unauthorized: send Authorization: Bearer ${BRAND.idPrefix}<key>` }, id: null },
    { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="mcp"' } },
  );
}

export function mcpRoutes(app: Hono): Hono {
  const routes = new Hono();
  routes.use("/mcp", cors({
    origin: "*",
    allowMethods: ["POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "Mcp-Protocol-Version", "Mcp-Session-Id", "Last-Event-ID"],
  }));

  routes.all("/mcp", async (c) => {
    // Stateless server: there is no server-initiated stream to open (GET) and no session to end (DELETE).
    if (c.req.method !== "POST") return c.body(null, 405, { Allow: "POST" });
    // API keys only — a dashboard session cookie must not drive an agent.
    if (!c.req.header("authorization")?.startsWith(`Bearer ${BRAND.idPrefix}`)) return unauthorized();
    const auth = await authenticate(c.req.raw).catch(() => null);
    if (auth?.authMethod !== "api_key") return unauthorized();

    const allowed = OPERATIONS.filter((op) => scopeAllows(auth.scopes, op.scope));
    const byName = new Map(allowed.map((op) => [op.name, op]));
    const compact = c.req.query("mode") === "compact";
    const forwarded = new Headers();
    for (const h of FORWARDED_HEADERS) { const v = c.req.header(h); if (v) forwarded.set(h, v); }

    async function callApi(op: McpOperation | undefined, args: Record<string, unknown>): Promise<CallToolResult> {
      if (!op) return toolError("Unknown operation, or not permitted for this API key's scopes.");
      let request: ReturnType<typeof buildApiRequest>;
      try { request = buildApiRequest(op, args); } catch (e) { return toolError((e as Error).message); }
      const headers = new Headers(forwarded);
      if (request.body !== undefined) headers.set("content-type", "application/json");
      const res = await app.request(new URL(request.path, c.req.url), { method: op.method, headers, body: request.body });
      const text = (await res.text()) || `HTTP ${res.status}`;
      return { content: [{ type: "text", text }], isError: !res.ok };
    }

    const server = new Server(
      { name: BRAND.name, version: APP_VERSION },
      { capabilities: { tools: {} }, instructions: `${BRAND.name} REST API (${allowed.length} operations for this key). Tool results are the API's JSON envelope { data, error, meta }.` },
    );
    server.setRequestHandler("tools/list", () => ({ tools: compact ? COMPACT_TOOLS : allowed.map(asTool) }));
    server.setRequestHandler("tools/call", async ({ params }) => {
      const args = params.arguments ?? {};
      if (!compact) return callApi(byName.get(params.name), args);
      if (params.name === "search_operations") {
        const found = searchOperations(allowed, String(args.query ?? ""));
        const listing = found.map((op) => ({ operationId: op.name, method: op.method, path: op.path, summary: op.summary, inputSchema: op.inputSchema, annotations: op.annotations }));
        return { content: [{ type: "text", text: JSON.stringify(listing) }] };
      }
      if (params.name === "call_operation") {
        return callApi(byName.get(String(args.operationId)), (args.params ?? {}) as Record<string, unknown>);
      }
      return toolError(`Unknown tool: ${params.name}`);
    });

    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });
  return routes;
}

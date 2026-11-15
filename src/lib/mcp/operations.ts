/**
 * MCP as a thin client over the OpenAPI spec: every tool is derived, at request time, from the
 * spec object this app version serves. No hand-written tools, no copied schemas, no business logic.
 *
 * Curation lives in the spec: `x-required-scope` (visibility per API key), `x-mcp.exclude`,
 * `x-mcp.description` (agent-facing override) and `x-mcp.destructive` (annotation hint).
 */
import { isInstanceScope } from "@/lib/auth/scopes";

type Json = Record<string, unknown>;
type Schema = Json;

interface SpecParameter { name: string; in: string; required?: boolean; description?: string; schema?: Schema }
interface SpecOperation {
  operationId?: string; summary?: string; description?: string; tags?: string[];
  parameters?: SpecParameter[]; security?: Array<Record<string, unknown>>;
  requestBody?: { required?: boolean; content?: Record<string, { schema?: Schema }> };
  "x-required-scope"?: string;
  "x-mcp"?: { exclude?: boolean; description?: string; destructive?: boolean };
}
interface SpecPathItem { parameters?: SpecParameter[]; servers?: Array<{ url: string }>; [method: string]: unknown }
export interface OpenApiDocument { servers?: Array<{ url: string }>; components?: Json; paths: Record<string, SpecPathItem> }

export interface McpOperation {
  name: string;
  method: string;
  /** Absolute app path template, e.g. `/api/v1/posts/{postId}`. */
  path: string;
  scope: string;
  summary: string;
  description: string;
  tags: string[];
  params: Array<{ name: string; in: "path" | "query" }>;
  hasBody: boolean;
  inputSchema: Schema & { type: "object" };
  annotations: { title: string; readOnlyHint?: boolean; destructiveHint?: boolean };
}

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

/** Inline local `$ref`s so each tool's inputSchema is self-contained; a cycle becomes an open schema. */
function resolveRefs(node: unknown, spec: OpenApiDocument, seen: string[] = []): unknown {
  if (Array.isArray(node)) return node.map((n) => resolveRefs(n, spec, seen));
  if (!node || typeof node !== "object") return node;
  const ref = (node as Json).$ref;
  if (typeof ref === "string" && ref.startsWith("#/")) {
    if (seen.includes(ref)) return {};
    const target = ref.slice(2).split("/").reduce<unknown>((acc, key) => (acc as Json | undefined)?.[key], spec);
    return resolveRefs(target ?? {}, spec, [...seen, ref]);
  }
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, resolveRefs(v, spec, seen)]));
}

/** API keys can call an operation only when it is Bearer-authenticated (global or per-operation security). */
const acceptsApiKey = (op: SpecOperation) => !op.security || op.security.some((s) => "BearerAuth" in s);

/** Every operation an API key could call, as MCP tool definitions. */
export function mcpOperations(spec: OpenApiDocument): McpOperation[] {
  const out: McpOperation[] = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of METHODS) {
      const op = item[method] as SpecOperation | undefined;
      const scope = op?.["x-required-scope"];
      if (!op || !scope || op["x-mcp"]?.exclude || !acceptsApiKey(op)) continue;
      const json = op.requestBody?.content?.["application/json"];
      if (op.requestBody && !json) continue; // binary/multipart-only bodies cannot be sent as tool arguments
      const params = [...(item.parameters ?? []), ...(op.parameters ?? [])].filter((p) => p.in === "path" || p.in === "query");
      const properties: Json = {};
      const required: string[] = [];
      for (const p of params) {
        properties[p.name] = resolveRefs({ ...p.schema, ...(p.description ? { description: p.description } : {}) }, spec);
        if (p.required || p.in === "path") required.push(p.name);
      }
      if (json) {
        properties.body = resolveRefs(json.schema ?? { type: "object" }, spec);
        if (op.requestBody?.required) required.push("body");
      }
      const summary = op.summary ?? "";
      const base = item.servers?.[0]?.url ?? spec.servers?.[0]?.url ?? "";
      out.push({
        name: op.operationId!,
        method: method.toUpperCase(),
        path: `${base}${path}`,
        scope,
        summary,
        description: op["x-mcp"]?.description ?? [summary, op.description].filter(Boolean).join("\n\n"),
        tags: op.tags ?? [],
        params: params.map((p) => ({ name: p.name, in: p.in as "path" | "query" })),
        hasBody: !!json,
        inputSchema: { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false },
        annotations: {
          title: summary,
          ...(method === "get" ? { readOnlyHint: true } : { readOnlyHint: false }),
          ...(method === "delete" || op["x-mcp"]?.destructive ? { destructiveHint: true } : {}),
        },
      });
    }
  }
  return out;
}

/** Same rule as the API: an empty scope list grants everything except `instance_*`, which must be explicit. */
export function scopeAllows(keyScopes: readonly string[], scope: string): boolean {
  if (isInstanceScope(scope)) return keyScopes.includes(scope);
  return keyScopes.length === 0 || keyScopes.includes(scope);
}

/** Compact mode search: every query word must occur in the name, path, summary, description or tags. */
export function searchOperations(ops: McpOperation[], query: string, limit = 20): McpOperation[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return ops
    .filter((op) => {
      const hay = [op.name, op.method, op.path, op.summary, op.description, ...op.tags].join(" ").toLowerCase();
      return words.every((w) => hay.includes(w));
    })
    .slice(0, limit);
}

/** Map tool arguments onto the HTTP request the API documents. Missing path parameters are a caller error. */
export function buildApiRequest(op: McpOperation, args: Json): { path: string; body?: string } {
  let path = op.path;
  const query = new URLSearchParams();
  for (const p of op.params) {
    const value = args[p.name];
    if (p.in === "path") {
      if (value === undefined || value === null || value === "") throw new Error(`Missing path parameter: ${p.name}`);
      path = path.replace(`{${p.name}}`, encodeURIComponent(String(value)));
    } else if (value !== undefined && value !== null) {
      for (const v of Array.isArray(value) ? value : [value]) query.append(p.name, typeof v === "object" ? JSON.stringify(v) : String(v));
    }
  }
  const qs = query.toString();
  return { path: qs ? `${path}?${qs}` : path, ...(op.hasBody && args.body !== undefined ? { body: JSON.stringify(args.body) } : {}) };
}

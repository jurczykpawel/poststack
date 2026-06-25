import { eq, desc } from "drizzle-orm";
import { authenticate, generateApiKey } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiKeys } from "@/db/schema";
import { ok, created, ApiErrors } from "@/lib/api/response";
import { rateLimit } from "@/lib/api/rate-limit";
import { parseJsonBody } from "@/lib/api/body-limit";
import { proGate } from "@/lib/api/pro-gate";
import { z } from "zod";

export const runtime = "nodejs";

// GET /api/v1/api-keys
export async function GET(request: Request) {
  const auth = await authenticate(request).catch(() => null);
  if (!auth) return ApiErrors.unauthorized();
  // Key management is session-only: an API key must not be able to enumerate,
  // create, or revoke keys (a restricted key could otherwise mint a full one).
  if (auth.authMethod === "api_key") return ApiErrors.forbidden("API key management requires a logged-in session");

  const keys = await db.query.apiKeys.findMany({
    where: eq(apiKeys.workspace_id, auth.workspaceId),
    orderBy: desc(apiKeys.created_at),
    columns: {
      id: true,
      name: true,
      key_prefix: true,
      scopes: true,
      last_used_at: true,
      expires_at: true,
      created_at: true,
    },
  });

  return ok(keys);
}

export const VALID_SCOPES = [
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
] as const;

const createSchema = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.enum(VALID_SCOPES)).default([]),
  expires_at: z.string().datetime().optional(),
});

// POST /api/v1/api-keys
// Returns the plaintext key ONCE — not stored, cannot be retrieved later
export async function POST(request: Request) {
  const auth = await authenticate(request).catch(() => null);
  if (!auth) return ApiErrors.unauthorized();
  if (auth.authMethod === "api_key") return ApiErrors.forbidden("API key management requires a logged-in session");

  // API access is PRO: gate key CREATION (authentication is gated separately in authenticateApiKey,
  // so existing keys also hard-stop on a downgrade). 402 with an upgrade link.
  const gate = await proGate("api_access");
  if (gate) return gate;

  // Rate limit: 10 key creations per hour per workspace
  const rl = await rateLimit(`rl:apikey:${auth.workspaceId}`, 10, 3600);
  if (!rl.allowed) {
    return ApiErrors.tooManyRequests("Too many API key creations. Try again later.");
  }

  const body = await parseJsonBody(request, 4_096);
  if (body === null) {
    return ApiErrors.badRequest("Invalid or oversized request body");
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return ApiErrors.validationError(parsed.error);
  }

  const { plaintext, prefix, hash } = generateApiKey();

  const [apiKey] = await db
    .insert(apiKeys)
    .values({
      workspace_id: auth.workspaceId,
      name: parsed.data.name,
      key_hash: hash,
      key_prefix: prefix,
      scopes: parsed.data.scopes,
      expires_at: parsed.data.expires_at ? new Date(parsed.data.expires_at) : null,
    })
    .returning({
      id: apiKeys.id,
      name: apiKeys.name,
      key_prefix: apiKeys.key_prefix,
      expires_at: apiKeys.expires_at,
      created_at: apiKeys.created_at,
    });

  // plaintext is returned ONCE and never stored
  return created({ ...apiKey, key: plaintext });
}

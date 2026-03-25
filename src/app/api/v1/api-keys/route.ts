import { authenticate } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ok, created, ApiErrors } from "@/lib/api/response";
import { generateApiKey } from "@/lib/auth";
import { rateLimit } from "@/lib/api/rate-limit";
import { z } from "zod";

export const runtime = "nodejs";

// GET /api/v1/api-keys
export async function GET(request: Request) {
  const auth = await authenticate(request).catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const keys = await prisma.apiKey.findMany({
    where: { workspace_id: auth.workspaceId },
    orderBy: { created_at: "desc" },
    select: {
      id: true,
      name: true,
      key_prefix: true,
      last_used_at: true,
      expires_at: true,
      created_at: true,
    },
  });

  return ok(keys);
}

const createSchema = z.object({
  name: z.string().min(1).max(100),
  expires_at: z.string().datetime().optional(),
});

// POST /api/v1/api-keys
// Returns the plaintext key ONCE — not stored, cannot be retrieved later
export async function POST(request: Request) {
  const auth = await authenticate(request).catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  // Rate limit: 10 key creations per hour per workspace
  const rl = await rateLimit(`rl:apikey:${auth.workspaceId}`, 10, 3600);
  if (!rl.allowed) {
    return ApiErrors.tooManyRequests("Too many API key creations. Try again later.");
  }

  const body = await request.json().catch(() => ({}));
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return ApiErrors.validationError(parsed.error.flatten().fieldErrors);
  }

  const { plaintext, prefix, hash } = generateApiKey();

  const apiKey = await prisma.apiKey.create({
    data: {
      workspace_id: auth.workspaceId,
      name: parsed.data.name,
      key_hash: hash,
      key_prefix: prefix,
      expires_at: parsed.data.expires_at ? new Date(parsed.data.expires_at) : null,
    },
    select: { id: true, name: true, key_prefix: true, expires_at: true, created_at: true },
  });

  // plaintext is returned ONCE and never stored
  return created({ ...apiKey, key: plaintext });
}

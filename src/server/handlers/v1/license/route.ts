import { z } from "zod";
import { authenticateWithScope } from "@/lib/auth";
import { ok, err, ApiErrors } from "@/lib/api/response";
import { getInstanceLicense, setLicense, clearLicense, licenseRejectionMessage, type LicenseState } from "@/lib/license/gate";
import { isAiConfigured } from "@/lib/ai/client";

export const runtime = "nodejs";

// Public view of the instance capabilities — the raw license token is never exposed. `ai_configured`
// tells API consumers (agents / automations) whether an AI provider key is set: the AI-dependent
// features (`ai_draft`, `rephrase`) only actually run when they are BOTH in `features` (PRO) AND
// `ai_configured` is true. Without a key those actions are inert, so surface it here for discovery.
function publicState(s: LicenseState, aiConfigured: boolean) {
  return {
    tier: s.tier,
    status: s.status,
    expires_at: s.expiresAt,
    source: s.source,
    features: [...s.features],
    upgrade_url: s.upgradeUrl,
    ai_configured: aiConfigured,
  };
}

// GET /api/v1/license — current license status (no token) + whether an AI provider is configured.
export async function GET(request: Request) {
  const auth = await authenticateWithScope(request, "settings:read").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();
  const [state, aiConfigured] = await Promise.all([getInstanceLicense(), isAiConfigured()]);
  return ok(publicState(state, aiConfigured));
}

const postSchema = z.object({ token: z.string().min(1) });

// POST /api/v1/license — verify + store a license token.
export async function POST(request: Request) {
  const auth = await authenticateWithScope(request, "settings:write").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const body = await request.json().catch(() => ({}));
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) return ApiErrors.validationError(parsed.error);

  const result = await setLicense(parsed.data.token.trim());
  if (!result.ok) {
    return err("INVALID_LICENSE", licenseRejectionMessage(result.reason), 422, { reason: result.reason });
  }
  return ok(publicState(result.state, await isAiConfigured()));
}

// DELETE /api/v1/license — drop the stored token, revert to env/free.
export async function DELETE(request: Request) {
  const auth = await authenticateWithScope(request, "settings:write").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();
  return ok(publicState(await clearLicense(), await isAiConfigured()));
}

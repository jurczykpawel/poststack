import { z } from "zod";
import { authenticateWithScope } from "@/lib/auth";
import { ok, err, ApiErrors } from "@/lib/api/response";
import { getInstanceLicense, setLicense, clearLicense, type LicenseState } from "@/lib/license/gate";

export const runtime = "nodejs";

// Public view of the license — the raw token is never exposed.
function publicState(s: LicenseState) {
  return {
    tier: s.tier,
    status: s.status,
    expires_at: s.expiresAt,
    source: s.source,
    features: [...s.features],
    upgrade_url: s.upgradeUrl,
  };
}

// GET /api/v1/license — current license status (no token).
export async function GET(request: Request) {
  const auth = await authenticateWithScope(request, "settings:read").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();
  return ok(publicState(await getInstanceLicense()));
}

const postSchema = z.object({ token: z.string().min(1) });

// POST /api/v1/license — verify + store a license token.
export async function POST(request: Request) {
  const auth = await authenticateWithScope(request, "settings:write").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const body = await request.json().catch(() => ({}));
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) return ApiErrors.validationError(parsed.error.flatten().fieldErrors);

  const result = await setLicense(parsed.data.token.trim());
  if (!result.ok) {
    return err("INVALID_LICENSE", `License rejected: ${result.reason}`, 422, { reason: result.reason });
  }
  return ok(publicState(result.state));
}

// DELETE /api/v1/license — drop the stored token, revert to env/free.
export async function DELETE(request: Request) {
  const auth = await authenticateWithScope(request, "settings:write").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();
  return ok(publicState(await clearLicense()));
}

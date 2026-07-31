import { authenticate } from "@/lib/auth";
import { ok, ApiErrors } from "@/lib/api/response";
import { camelizeKeys } from "@/lib/api/serialize";
import { getBrand } from "@/lib/brands/service";
import { resolveBrandSlots } from "@/lib/brands/resolve";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ brandKey: string }> };

/**
 * BRANDCH1: GET /api/v1/brands/:brandKey/channels — which live channel this brand publishes to on
 * each editorial platform. The answer an agent needs before `POST /posts/:id/publish`: `GET /channels`
 * doesn't expose `brand_key` at all, so without this a caller can only filter by platform and guess
 * once a workspace connects more than one account per platform.
 *
 * `channel: null` means unmapped OR ambiguous (`ambiguous: true` = several candidates) — resolution
 * never guesses, mirroring `resolveChannelForBrandPlatform` (the same rule the publish path uses).
 * An unregistered brand is 404, not an empty list, so a caller stops instead of publishing blind.
 */
export async function GET(request: Request, ctx: Ctx): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth) return ApiErrors.unauthorized();
  const { brandKey } = await ctx.params;
  const brand = await getBrand(auth.workspaceId, brandKey);
  if (!brand) return ApiErrors.notFound("Brand");
  return ok(camelizeKeys(await resolveBrandSlots(auth.workspaceId, brandKey)));
}

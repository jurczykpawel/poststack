import { z } from "zod";
import { authenticate } from "@/lib/auth";
import { ok, noContent, ApiErrors, zodDetails } from "@/lib/api/response";
import { camelizeKeys } from "@/lib/api/serialize";
import { updateBrand, deleteBrand } from "@/lib/brands/service";
import { LIMITS } from "@/lib/api/limits";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ brandKey: string }> };

const brandPatch = z.object({
  name: z.string().min(1).max(LIMITS.name).optional(),
  accent: z.string().max(LIMITS.line).nullable().optional(),
  icon: z.string().max(LIMITS.line).nullable().optional(),
});

export async function PATCH(request: Request, ctx: Ctx): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth) return ApiErrors.unauthorized();
  const { brandKey } = await ctx.params;
  const body = await request.json().catch(() => ({}));
  const parsed = brandPatch.safeParse(body);
  if (!parsed.success) return ApiErrors.validationError(zodDetails(parsed.error));
  const row = await updateBrand(auth.workspaceId, brandKey, parsed.data);
  return ok(camelizeKeys(row));
}

export async function DELETE(request: Request, ctx: Ctx): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth) return ApiErrors.unauthorized();
  const { brandKey } = await ctx.params;
  await deleteBrand(auth.workspaceId, brandKey);
  return noContent();
}

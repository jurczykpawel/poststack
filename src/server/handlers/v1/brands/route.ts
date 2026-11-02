import { z } from "zod";
import { authenticateWithScope } from "@/lib/auth";
import { ok, created, ApiErrors, zodDetails } from "@/lib/api/response";
import { camelizeKeys } from "@/lib/api/serialize";
import { listBrands, createBrand } from "@/lib/brands/service";
import { BRAND_KEY_RE, BRAND_ACCENT_RE } from "@/lib/brands/validation";
import { LIMITS } from "@/lib/api/limits";

export const runtime = "nodejs";

const brandCreate = z.object({
  key: z.string().min(1).max(LIMITS.ref).regex(BRAND_KEY_RE, "letters, digits, dots, dashes and underscores only"),
  name: z.string().min(1).max(LIMITS.name),
  accent: z.string().regex(BRAND_ACCENT_RE, "hex colour like #7aa2f7").optional(),
  icon: z.string().max(LIMITS.line).optional(),
  story_template: z.string().max(LIMITS.ref).nullable().optional(),
  // AIDISC2: brand-wide default AI declaration. Explicit null clears it.
  default_ai_disclosure: z.enum(["none", "ai_assisted", "ai_generated"]).nullish(),
  default_ai_disclosure_note: z.string().max(LIMITS.line).nullish(),
});

export async function GET(request: Request): Promise<Response> {
  const auth = await authenticateWithScope(request, "brands:read");
  if (!auth) return ApiErrors.unauthorized();
  return ok(camelizeKeys(await listBrands(auth.workspaceId)));
}

export async function POST(request: Request): Promise<Response> {
  const auth = await authenticateWithScope(request, "brands:write");
  if (!auth) return ApiErrors.unauthorized();
  const body = await request.json().catch(() => ({}));
  const parsed = brandCreate.safeParse(body);
  if (!parsed.success) return ApiErrors.validationError(zodDetails(parsed.error));
  const row = await createBrand(parsed.data, auth.workspaceId);
  return created(camelizeKeys(row));
}

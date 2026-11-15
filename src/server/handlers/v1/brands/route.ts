import { authenticateWithScope } from "@/lib/auth";
import { ok, created, ApiErrors, zodDetails } from "@/lib/api/response";
import { camelizeKeys } from "@/lib/api/serialize";
import { listBrands, createBrand } from "@/lib/brands/service";
import { brandCreate } from "@/lib/brands/validation";

export const runtime = "nodejs";

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

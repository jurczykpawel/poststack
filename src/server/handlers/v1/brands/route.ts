import { z } from "zod";
import { authenticate } from "@/lib/auth";
import { ok, created, ApiErrors, zodDetails } from "@/lib/api/response";
import { camelizeKeys } from "@/lib/api/serialize";
import { listBrands, createBrand } from "@/lib/brands/service";
import { LIMITS } from "@/lib/api/limits";

export const runtime = "nodejs";

const brandCreate = z.object({
  key: z.string().min(1).max(LIMITS.ref),
  name: z.string().min(1).max(LIMITS.name),
  accent: z.string().max(LIMITS.line).optional(),
  icon: z.string().max(LIMITS.line).optional(),
});

export async function GET(request: Request): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth) return ApiErrors.unauthorized();
  return ok(camelizeKeys(await listBrands(auth.workspaceId)));
}

export async function POST(request: Request): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth) return ApiErrors.unauthorized();
  const body = await request.json().catch(() => ({}));
  const parsed = brandCreate.safeParse(body);
  if (!parsed.success) return ApiErrors.validationError(zodDetails(parsed.error));
  const row = await createBrand(parsed.data, auth.workspaceId);
  return created(camelizeKeys(row));
}

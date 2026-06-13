import { authenticate } from "@/lib/auth";
import { ok, noContent, ApiErrors, zodDetails } from "@/lib/api/response";
import { camelizeKeys } from "@/lib/api/serialize";
import { getContent, patchContent, deleteContent } from "@/lib/content/service";
import { contentPatch } from "@/lib/content/schemas";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ contentId: string }> };

export async function GET(request: Request, ctx: Ctx): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth) return ApiErrors.unauthorized();
  const { contentId } = await ctx.params;
  const row = await getContent(contentId, auth.workspaceId);
  if (!row) return ApiErrors.notFound("Content");
  return ok(camelizeKeys(row));
}

export async function PATCH(request: Request, ctx: Ctx): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth) return ApiErrors.unauthorized();
  const { contentId } = await ctx.params;
  const body = await request.json().catch(() => ({}));
  const parsed = contentPatch.safeParse(body);
  if (!parsed.success) return ApiErrors.validationError(zodDetails(parsed.error));
  const row = await patchContent(contentId, auth.workspaceId, parsed.data);
  if (!row) return ApiErrors.notFound("Content");
  return ok(camelizeKeys(row));
}

export async function DELETE(request: Request, ctx: Ctx): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth) return ApiErrors.unauthorized();
  const { contentId } = await ctx.params;
  if (!(await deleteContent(contentId, auth.workspaceId))) return ApiErrors.notFound("Content");
  return noContent();
}

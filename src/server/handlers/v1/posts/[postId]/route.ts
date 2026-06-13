import { authenticate } from "@/lib/auth";
import { ok, noContent, ApiErrors, zodDetails } from "@/lib/api/response";
import { camelizeKeys } from "@/lib/api/serialize";
import { getPost, patchPost, deletePost } from "@/lib/content/service";
import { postPatch } from "@/lib/content/schemas";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ postId: string }> };

export async function GET(request: Request, ctx: Ctx): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth) return ApiErrors.unauthorized();
  const { postId } = await ctx.params;
  const row = await getPost(postId, auth.workspaceId);
  if (!row) return ApiErrors.notFound("Post");
  return ok(camelizeKeys(row));
}

export async function PATCH(request: Request, ctx: Ctx): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth) return ApiErrors.unauthorized();
  const { postId } = await ctx.params;
  const body = await request.json().catch(() => ({}));
  const parsed = postPatch.safeParse(body);
  if (!parsed.success) return ApiErrors.validationError(zodDetails(parsed.error));
  const row = await patchPost(postId, auth.workspaceId, parsed.data);
  if (!row) return ApiErrors.notFound("Post");
  return ok(camelizeKeys(row));
}

export async function DELETE(request: Request, ctx: Ctx): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth) return ApiErrors.unauthorized();
  const { postId } = await ctx.params;
  if (!(await deletePost(postId, auth.workspaceId))) return ApiErrors.notFound("Post");
  return noContent();
}

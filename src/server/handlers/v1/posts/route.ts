import { authenticate } from "@/lib/auth";
import { ok, created, ApiErrors, zodDetails } from "@/lib/api/response";
import { camelizeKeys } from "@/lib/api/serialize";
import { clampLimit } from "@/lib/api/pagination";
import { listPosts, createPost } from "@/lib/content/service";
import { postCreate } from "@/lib/content/schemas";
import { readIdempotencyKey } from "@/server/handlers/v1/_publishing";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth) return ApiErrors.unauthorized();
  const q = new URL(request.url).searchParams;
  const res = await listPosts({
    workspaceId: auth.workspaceId,
    limit: clampLimit(q.get("limit") ?? undefined),
    cursor: q.get("cursor") ?? undefined,
    sort: q.get("sort") ?? undefined,
    contentId: q.get("contentId") ?? undefined,
    platform: q.get("platform") ?? undefined,
    status: q.get("status") ?? undefined,
    q: q.get("q") ?? undefined,
  });
  return ok(camelizeKeys(res));
}

export async function POST(request: Request): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth) return ApiErrors.unauthorized();
  const body = await request.json().catch(() => ({}));
  const parsed = postCreate.safeParse(body);
  if (!parsed.success) return ApiErrors.validationError(zodDetails(parsed.error));
  const row = await createPost(parsed.data, auth.workspaceId, readIdempotencyKey(request));
  return created(camelizeKeys(row));
}

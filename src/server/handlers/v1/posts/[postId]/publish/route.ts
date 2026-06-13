import { z } from "zod";
import { authenticate } from "@/lib/auth";
import { ok, ApiErrors, zodDetails } from "@/lib/api/response";
import { camelizeKeys } from "@/lib/api/serialize";
import { publishPost } from "@/lib/content/publish";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ postId: string }> };

const publishBody = z.object({
  channelId: z.string().uuid(),
  when: z.string().min(1).default("now"), // "now" or an ISO timestamp
  format: z.string().min(1).max(255).optional(),
});

/** Publish (or schedule) an editorial post through the delivery engine (PUBLISHCARD1). */
export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth) return ApiErrors.unauthorized();
  const { postId } = await ctx.params;
  const body = await request.json().catch(() => ({}));
  const parsed = publishBody.safeParse(body);
  if (!parsed.success) return ApiErrors.validationError(zodDetails(parsed.error));
  const result = await publishPost({ postId, ...parsed.data }, auth.workspaceId);
  return ok(camelizeKeys(result));
}

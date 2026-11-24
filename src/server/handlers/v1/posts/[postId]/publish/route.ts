import { z } from "zod";
import { authenticateWithScope } from "@/lib/auth";
import { ok, ApiErrors, zodDetails } from "@/lib/api/response";
import { camelizeKeys } from "@/lib/api/serialize";
import { actorFromAuth } from "@/lib/audit";
import { publishTimestamp } from "@/lib/content/schemas";
import { publishPost } from "@/lib/content/publish";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ postId: string }> };

const publishBody = z.object({
  channelId: z.string().uuid(),
  tiktokConsent: z.boolean().optional(),
  when: z.union([z.literal("now"), publishTimestamp], { error: "Use now or an ISO 8601 date and time with Z or a UTC offset." }).default("now"),
  format: z.string().min(1).max(255).optional(),
});

/** Publish (or schedule) an editorial post through the delivery engine (PUBLISHCARD1). */
export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  const auth = await authenticateWithScope(request, "posts:write");
  if (!auth) return ApiErrors.unauthorized();
  const { postId } = await ctx.params;
  const body = await request.json().catch(() => ({}));
  const parsed = publishBody.safeParse(body);
  if (!parsed.success) return ApiErrors.validationError(zodDetails(parsed.error));
  const result = await publishPost({ postId, ...parsed.data, actor: actorFromAuth(auth) }, auth.workspaceId);
  return ok(camelizeKeys(result));
}

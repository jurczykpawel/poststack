import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels, deliveries, posts } from "@/db/schema";
import { authenticateWithScope } from "@/lib/auth";
import { ApiErrors, err, ok } from "@/lib/api/response";
import { decryptTokens } from "@/lib/crypto";
import { toTokenSet } from "@/lib/providers/token-codec";
import { xPlatformPost } from "@/lib/providers/x";

export async function handle(request: Request, ctx: { params: Promise<{ postId: string }> }): Promise<Response> {
  const auth = await authenticateWithScope(request, request.method === "DELETE" ? "posts:write" : "posts:read");
  if (!auth) return ApiErrors.unauthorized();
  const { postId } = await ctx.params;
  const [row] = await db.select({ delivery: deliveries, channel: channels }).from(posts)
    .innerJoin(deliveries, and(eq(deliveries.id, posts.delivery_id), eq(deliveries.workspace_id, auth.workspaceId)))
    .innerJoin(channels, and(eq(channels.id, deliveries.channel_id), eq(channels.workspace_id, auth.workspaceId), isNull(channels.deleted_at)))
    .where(and(eq(posts.id, postId), eq(posts.workspace_id, auth.workspaceId)));
  if (!row) return ApiErrors.notFound("Published post");
  const { delivery: d, channel: c } = row;
  if (c.platform !== "twitter" || d.status !== "sent" || !d.provider_handle) return ApiErrors.conflict("Requires a sent X post");
  const tokens = toTokenSet(decryptTokens(c.token_encrypted, [`ws:${c.workspace_id}`, "channels.token_encrypted", c.platform, c.platform_id]));
  try {
    return ok(await xPlatformPost(tokens, d.provider_handle, request.method === "DELETE" ? "DELETE" : "GET"));
  } catch {
    return err("provider_error", "X operation failed; inspect channel credentials, credits and rate limits", 502);
  }
}

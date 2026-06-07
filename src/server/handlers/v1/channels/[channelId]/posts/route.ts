import { and, eq } from "drizzle-orm";
import { authenticateWithScope } from "@/lib/auth";
import { db } from "@/lib/db";
import { channels } from "@/db/schema";
import { decryptTokens } from "@/lib/crypto";
import { ok, ApiErrors } from "@/lib/api/response";
import { GRAPH_API_BASE } from "@/lib/platforms/constants";

export const runtime = "nodejs";

const GRAPH_API = GRAPH_API_BASE;

interface MetaPost {
  id: string;
  message?: string;
  created_time: string;
  full_picture?: string;
  permalink_url?: string;
}

/**
 * GET /api/v1/channels/:channelId/posts
 * Fetches the last 10 posts from the connected Facebook Page / Instagram account.
 * Used by the Rules UI for post_id selection in comment_keyword rules.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ channelId: string }> }
) {
  const auth = await authenticateWithScope(request, "channels:read").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const { channelId } = await params;
  const channel = await db.query.channels.findFirst({
    where: and(eq(channels.id, channelId), eq(channels.workspace_id, auth.workspaceId)),
    columns: { id: true, platform: true, platform_id: true, token_encrypted: true },
  });

  if (!channel) return ApiErrors.notFound("Channel");

  const tokens = decryptTokens(channel.token_encrypted);

  try {
    const res = await fetch(
      `${GRAPH_API}/${channel.platform_id}/feed?` +
        new URLSearchParams({
          fields: "id,message,created_time,full_picture,permalink_url",
          limit: "10",
          access_token: tokens.access_token,
        }),
      { redirect: "error", signal: AbortSignal.timeout(10_000) }
    );

    if (!res.ok) {
      const body = await res.text();
      console.error("[channels/posts] Meta API error:", body);
      return ApiErrors.badRequest("Failed to fetch posts from Meta");
    }

    const data = (await res.json()) as { data: MetaPost[] };

    const posts = data.data.map((p) => ({
      id: p.id,
      text: p.message ? (p.message.length > 100 ? p.message.slice(0, 100) + "..." : p.message) : "(no text)",
      created_at: p.created_time,
      image: p.full_picture ?? null,
      url: p.permalink_url ?? null,
    }));

    return ok(posts);
  } catch (err) {
    console.error("[channels/posts] Error:", err);
    return ApiErrors.internal("Failed to fetch posts");
  }
}

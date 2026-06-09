import { and, eq } from "drizzle-orm";
import { authenticateWithScope } from "@/lib/auth";
import { db } from "@/lib/db";
import { channels } from "@/db/schema";
import { decryptTokens } from "@/lib/crypto";
import { ok, ApiErrors } from "@/lib/api/response";
import { GRAPH_API_BASE } from "@/lib/platforms/constants";
import { truncateCodePoints } from "@/lib/text";

export const runtime = "nodejs";

const GRAPH_API = GRAPH_API_BASE;

interface MetaPost {
  id: string;
  // Facebook /feed fields
  message?: string;
  created_time?: string;
  full_picture?: string;
  permalink_url?: string;
  // Instagram /media fields
  caption?: string;
  timestamp?: string;
  media_url?: string;
  permalink?: string;
}

/** Post preview: code-point-safe truncate with an ellipsis when shortened. */
function previewText(raw: string | undefined): string {
  if (!raw) return "(no text)";
  const truncated = truncateCodePoints(raw, 100);
  return truncated === raw ? raw : truncated + "...";
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

  // Decrypt inside its own guard: a corrupt token / rotated TOKEN_ENCRYPTION_KEY throws, and that
  // must surface as a clean 400, not an uncaught 500.
  let accessToken: string;
  try {
    accessToken = decryptTokens(channel.token_encrypted).access_token;
  } catch {
    return ApiErrors.badRequest("Channel token cannot be decrypted — reconnect the channel");
  }

  // Instagram posts live at /{ig-user-id}/media with IG-shaped fields; Facebook Pages use /feed.
  // Using /feed for an IG account errors out, breaking the comment_keyword post picker.
  const isInstagram = channel.platform === "instagram";
  const edge = isInstagram ? "media" : "feed";
  const fields = isInstagram
    ? "id,caption,timestamp,media_url,permalink"
    : "id,message,created_time,full_picture,permalink_url";

  try {
    const res = await fetch(
      `${GRAPH_API}/${channel.platform_id}/${edge}?` +
        new URLSearchParams({ fields, limit: "10", access_token: accessToken }),
      { redirect: "error", signal: AbortSignal.timeout(10_000) }
    );

    if (!res.ok) {
      const body = await res.text();
      console.error("[channels/posts] Meta API error:", body);
      return ApiErrors.badRequest("Failed to fetch posts from Meta");
    }

    const data = (await res.json()) as { data: MetaPost[] };

    // Normalize both platform shapes to one { id, text, created_at, image, url }.
    const posts = data.data.map((p) => ({
      id: p.id,
      text: previewText(isInstagram ? p.caption : p.message),
      created_at: (isInstagram ? p.timestamp : p.created_time) ?? null,
      image: (isInstagram ? p.media_url : p.full_picture) ?? null,
      url: (isInstagram ? p.permalink : p.permalink_url) ?? null,
    }));

    return ok(posts);
  } catch (err) {
    console.error("[channels/posts] Error:", err);
    return ApiErrors.internal("Failed to fetch posts");
  }
}

import { and, eq, or } from "drizzle-orm";
import { channels, media } from "@/db/schema";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api/response";
import type { ComposeInput } from "@/lib/content/compose";
import { resolveChannelForBrandPlatform } from "@/lib/brands/resolve";
import { validateDeliveryRequest } from "@/lib/deliveries/service";
import { getProviderForPlatform } from "@/lib/providers";
import { validate } from "@/lib/providers/validate";
import { buildCaption } from "@/lib/content/publish";
import { enqueueIngest } from "@/lib/media/async-ingest";

export async function validateComposeCarousel(input: ComposeInput, workspaceId: string) {
  const urls = input.mediaUrls ?? [input.mediaUrl];
  // A single TikTok photo also needs the verified-domain check before anything is created.
  const format = urls.length < 2 && input.contentType !== "carousel" ? "image" : "carousel";
  if (format === "image" && (input.contentType !== "image" || !input.posts.some(p => p.platform === "tiktok"))) return;
  for (const post of input.posts) {
    if (format === "image" && post.platform !== "tiktok") continue;
    const request = { format, media: urls.map(() => ({ mediaId: "" })), caption: buildCaption(post.description || input.baseDescription, input.baseHashtags) };
    const checked = validate(getProviderForPlatform(post.platform), request, { platform: post.platform });
    if (!checked.ok) throw new ApiError("invalid_request", checked.errors.join("; "), 422);
    const target = await resolveChannelForBrandPlatform(workspaceId, input.brand, post.platform);
    if (!target) throw new ApiError("invalid_request", `No ${post.platform} channel mapped for ${input.brand}`, 422);
    const channel = await db.query.channels.findFirst({ where: and(eq(channels.workspace_id, workspaceId), eq(channels.id, target.id)) });
    for (const [i, url] of urls.entries()) {
      const asset = await db.query.media.findFirst({ where: and(eq(media.workspace_id, workspaceId), eq(media.status, "ready"), or(eq(media.url, url), eq(media.source_url, url))) }) ?? await enqueueIngest(url, workspaceId);
      request.media[i] = { mediaId: asset.id };
    }
    await validateDeliveryRequest(request, workspaceId, post.platform, true, channel);
  }
}

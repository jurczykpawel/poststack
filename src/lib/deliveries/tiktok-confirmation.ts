import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { deliveries, posts } from "@/db/schema";
import { getDelivery } from "./service";
import { getTikTokCreatorInfo } from "@/lib/channels/tiktok-creator-info";
import { resolveMediaDetails } from "./resolve-media";
import { validateTikTokSubmission } from "@/lib/providers/tiktok";
import { tiktokPostSettings } from "@/lib/content/schemas";
import { postPublishOptions } from "@/lib/content/publish";
import { addJobTx } from "@/lib/queue/client";
import { ApiError } from "@/lib/api/response";
import type { PublishRequest } from "@/lib/providers/types";
import { recordAudit, AuditAction } from "@/lib/audit";

const inputSchema = tiktokPostSettings.extend({
  caption: z.string().max(2200), consent: z.literal(true), disclosure: z.boolean(),
  tiktokDisableComment: z.boolean().default(true), tiktokDisableDuet: z.boolean().default(true), tiktokDisableStitch: z.boolean().default(true),
  tiktokBrandContentToggle: z.boolean().default(false), tiktokBrandOrganicToggle: z.boolean().default(false),
});

export async function confirmTikTokDelivery(id: string, workspaceId: string, userId: string, input: unknown) {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new ApiError("invalid_request", "Confirm this submission with valid TikTok settings.", 422);
  const d = await getDelivery(id, workspaceId);
  if (!d) throw new ApiError("not_found", "Delivery not found", 404);
  if (d.status !== "held" || d.tiktok_confirmation !== "required") throw new ApiError("conflict", "Delivery does not need confirmation", 409);
  const data = parsed.data;
  const settings = {
    tiktok_publish_mode: data.tiktokPublishMode,
    tiktok_privacy_level: data.tiktokPrivacyLevel,
    tiktok_disable_comment: data.tiktokDisableComment,
    tiktok_disable_duet: data.tiktokDisableDuet,
    tiktok_disable_stitch: data.tiktokDisableStitch,
    tiktok_brand_content_toggle: data.tiktokBrandContentToggle,
    tiktok_brand_organic_toggle: data.tiktokBrandOrganicToggle,
    tiktok_cover_timestamp_ms: data.tiktokCoverTimestampMs,
  };
  if (!data.tiktokPublishMode) throw new ApiError("invalid_request", "Choose TikTok delivery mode", 422);
  if (data.tiktokPublishMode === "direct" && !data.tiktokPrivacyLevel) throw new ApiError("invalid_request", "Choose an available TikTok privacy level", 422);
  if (data.tiktokPublishMode === "direct" && data.disclosure && !data.tiktokBrandContentToggle && !data.tiktokBrandOrganicToggle) throw new ApiError("invalid_request", "Select at least one disclosure option", 422);
  const creator = await getTikTokCreatorInfo(workspaceId, d.channel_id, { refresh: true });
  if (creator.status !== "available") throw new ApiError("invalid_request", creator.message, 422);
  const request = d.payload as PublishRequest;
  const options = { ...request.options, ...postPublishOptions({ ...settings, youtube_privacy: null, youtube_tags: null, youtube_category_id: null, youtube_made_for_kids: null }) };
  if (data.tiktokPublishMode === "direct") {
    const media = await resolveMediaDetails(request.media, workspaceId);
    try { validateTikTokSubmission(creator, options, media[0]?.durationSec); }
    catch (err) { throw new ApiError("invalid_request", err instanceof Error ? err.message : "Review TikTok settings", 422); }
  }
  const payload = { ...request, caption: data.caption, options };
  await db.transaction(async (tx) => {
    await tx.select({ id: posts.id }).from(posts).where(and(eq(posts.workspace_id, workspaceId), eq(posts.delivery_id, id))).orderBy(posts.id).for("update");
    const [row] = await tx.update(deliveries).set({ status: "scheduled", tiktok_confirmation: "confirmed", payload, last_error: null, scheduled_at: new Date(), run_at: new Date(), updated_at: new Date() })
      .where(and(eq(deliveries.id, id), eq(deliveries.workspace_id, workspaceId), eq(deliveries.status, "held"), eq(deliveries.tiktok_confirmation, "required"))).returning({ id: deliveries.id });
    if (!row) throw new ApiError("conflict", "Delivery no longer needs confirmation", 409);
    await tx.update(posts).set({ ...settings, description: data.caption, hashtags: "", status: "scheduled", updated_at: new Date() })
      .where(and(eq(posts.workspace_id, workspaceId), eq(posts.delivery_id, id)));
    await addJobTx(tx, "publish", { postId: id }, { jobKey: `publish:${id}` });
  });
  await recordAudit({ workspaceId, actor: { type: "user", id: userId }, action: AuditAction.TikTokSubmissionConfirmed, targetType: "delivery", targetId: id, metadata: { channelId: d.channel_id, settings } });
}

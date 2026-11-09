import { FACEBOOK_VIDEO_CAROUSEL_HINT, type VideoCarouselChannel } from "@/lib/platforms/facebook-video-carousel";
import type { Provider, PublishRequest } from "./types";

export type ValidateResult = { ok: true } | { ok: false; errors: string[] };

export function validate(provider: Provider, request: PublishRequest, context?: { platform?: string; channel?: VideoCarouselChannel; mediaKinds?: string[] }): ValidateResult {
  const cap = provider.capabilities(context?.platform, context?.channel).find((c) => c.format === request.format);
  if (!cap) {
    return { ok: false, errors: [`unsupported format '${request.format}' for ${provider.id}`] };
  }
  const errors: string[] = [];
  const n = request.media.length;
  if (context?.mediaKinds?.some(kind => !cap.media.kinds.some(allowed => allowed === kind))) {
    if (context.platform === "facebook" && request.format === "carousel" && context.mediaKinds.includes("video") && context.channel?.video_carousel !== "available") errors.push(FACEBOOK_VIDEO_CAROUSEL_HINT);
    else errors.push(`${context.platform ?? provider.id} format '${request.format}' supports ${cap.media.kinds.join(" and ")} media only`);
  }
  if (n < cap.media.min) errors.push(`format '${request.format}' needs >= ${cap.media.min} media`);
  if (n > cap.media.max) errors.push(`format '${request.format}' allows <= ${cap.media.max} media`);
  if (cap.caption?.required && !request.caption) errors.push("caption is required");
  if (cap.caption && request.caption && request.caption.length > cap.caption.maxLength) {
    errors.push(`caption exceeds ${cap.caption.maxLength} chars`);
  }
  if (cap.title?.required && !request.title?.trim()) errors.push("title is required");
  if (cap.title && request.title && request.title.length > cap.title.maxLength) errors.push(`title exceeds ${cap.title.maxLength} chars`);
  if (request.format === "article") {
    try {
      const url = new URL(String(request.options?.articleUrl ?? ""));
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.href.length > 8192) throw new Error();
    } catch { errors.push("articleUrl must be an http(s) URL without credentials"); }
  }
  for (const opt of cap.requiredOptions ?? []) {
    if (request.options?.[opt] === undefined) errors.push(`missing required option '${opt}'`);
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

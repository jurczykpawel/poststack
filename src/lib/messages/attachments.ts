import type { MessageContent } from "@/lib/platforms/base";

/**
 * Normalized non-text content persisted in the existing `messages.attachments` jsonb column. Only the
 * keys actually present are included; the whole value is null when the message carries nothing but
 * text. We store TITLES only (no button payloads/urls) because the inbox shows operator-facing labels,
 * not the wire payloads — and titles keep the row small + free of redundant attacker/operator data.
 * Media keeps its {type,url} so the inbox can render a labelled link (thumbnails are a later step).
 */
export type StoredAttachments = {
  media?: Array<{ type: string; url: string }>;
  buttons?: Array<{ title: string }>;
  quick_replies?: Array<{ title: string }>;
};

/**
 * Project platform-neutral {@link MessageContent} down to what the inbox needs to render. Pure +
 * side-effect-free so it can be unit-tested and called from the outgoing-message worker at insert time.
 * Returns null for text-only (the worker stores null → the column stays empty, no false "(attachment)").
 */
export function normalizeOutgoingAttachments(content: MessageContent): StoredAttachments | null {
  const out: StoredAttachments = {};

  if (content.attachments && content.attachments.length > 0) {
    out.media = content.attachments.map((a) => ({ type: a.type, url: a.url }));
  }
  if (content.buttons && content.buttons.length > 0) {
    out.buttons = content.buttons.map((b) => ({ title: b.title }));
  }
  // Only text quick replies carry a title; user_email / user_phone_number ones are titleless prompts
  // with nothing to label, so they're dropped here.
  const quickReplies = (content.quick_replies ?? [])
    .filter((qr): qr is typeof qr & { title: string } => typeof qr.title === "string" && qr.title.length > 0)
    .map((qr) => ({ title: qr.title }));
  if (quickReplies.length > 0) out.quick_replies = quickReplies;

  return Object.keys(out).length > 0 ? out : null;
}

import type { MessageContent, QuickReply } from "./base";

export interface BuildMessageOptions {
  /**
   * Whether the platform renders `image_url` on text quick replies.
   * Messenger: yes. Instagram: no (the field is stripped so IG's API never rejects it).
   */
  allowQuickReplyImages: boolean;
}

/**
 * Build the Meta Send API `message` object from platform-neutral content.
 *
 * Precedence for the message body: a button template (buttons + text) wins,
 * else a single attachment, else plain text. Quick replies attach to whichever
 * body is produced. The output is valid for both Messenger and Instagram; the
 * per-platform `opts` strip features the platform cannot render.
 */
export function buildMessageObject(
  content: MessageContent,
  opts: BuildMessageOptions,
): Record<string, unknown> {
  const message: Record<string, unknown> = {};

  if (content.buttons && content.buttons.length > 0 && content.text) {
    message.attachment = {
      type: "template",
      payload: {
        template_type: "button",
        text: content.text,
        buttons: content.buttons.map((btn) =>
          btn.url
            ? { type: "web_url", url: btn.url, title: btn.title }
            : { type: "postback", title: btn.title, payload: btn.payload ?? btn.title },
        ),
      },
    };
  } else if (content.attachments && content.attachments.length > 0) {
    const att = content.attachments[0];
    message.attachment = {
      type: att.type || "file",
      payload: { url: att.url, is_reusable: true },
    };
  } else if (content.text) {
    message.text = content.text;
  }

  if (content.quick_replies && content.quick_replies.length > 0) {
    message.quick_replies = content.quick_replies.map((qr) =>
      buildQuickReply(qr, opts.allowQuickReplyImages),
    );
  }

  return message;
}

function buildQuickReply(qr: QuickReply, allowImages: boolean): Record<string, unknown> {
  const contentType = qr.content_type ?? "text";
  if (contentType === "user_email") return { content_type: "user_email" };
  if (contentType === "user_phone_number") return { content_type: "user_phone_number" };

  const out: Record<string, unknown> = {
    content_type: "text",
    title: qr.title,
    payload: qr.payload,
  };
  if (allowImages && qr.image_url) out.image_url = qr.image_url;
  return out;
}

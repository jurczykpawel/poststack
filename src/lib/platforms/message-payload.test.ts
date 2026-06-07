import { describe, it, expect } from "vitest";
import { buildMessageObject } from "./message-payload";

const FB = { allowQuickReplyImages: true };
const IG = { allowQuickReplyImages: false };

describe("buildMessageObject", () => {
  it("builds a plain text message", () => {
    expect(buildMessageObject({ text: "Hello" }, FB)).toEqual({ text: "Hello" });
  });

  it("builds an attachment message (first attachment, reusable)", () => {
    const msg = buildMessageObject(
      { attachments: [{ type: "image", url: "https://x/y.jpg" }] },
      FB,
    );
    expect(msg.attachment).toEqual({
      type: "image",
      payload: { url: "https://x/y.jpg", is_reusable: true },
    });
    expect(msg.text).toBeUndefined();
  });

  it("maps text quick replies, omitting image_url when platform disallows it", () => {
    const content = {
      text: "Pick:",
      quick_replies: [
        { content_type: "text" as const, title: "Yes", payload: "YES", image_url: "https://x/i.png" },
      ],
    };
    expect(buildMessageObject(content, FB).quick_replies).toEqual([
      { content_type: "text", title: "Yes", payload: "YES", image_url: "https://x/i.png" },
    ]);
    expect(buildMessageObject(content, IG).quick_replies).toEqual([
      { content_type: "text", title: "Yes", payload: "YES" },
    ]);
  });

  it("maps user_email / user_phone_number quick replies to content_type only", () => {
    const msg = buildMessageObject(
      {
        text: "Share:",
        quick_replies: [
          { content_type: "user_email" as const },
          { content_type: "user_phone_number" as const },
        ],
      },
      FB,
    );
    expect(msg.quick_replies).toEqual([
      { content_type: "user_email" },
      { content_type: "user_phone_number" },
    ]);
  });

  it("defaults quick replies without content_type to text", () => {
    const msg = buildMessageObject(
      { text: "q", quick_replies: [{ title: "A", payload: "A" }] },
      IG,
    );
    expect(msg.quick_replies).toEqual([{ content_type: "text", title: "A", payload: "A" }]);
  });

  it("builds a button template and removes plain text", () => {
    const msg = buildMessageObject(
      {
        text: "Choose:",
        buttons: [
          { title: "Visit", url: "https://example.com" },
          { title: "Start", payload: "GO" },
        ],
      },
      IG,
    );
    expect(msg.text).toBeUndefined();
    const att = msg.attachment as { type: string; payload: { template_type: string; text: string; buttons: unknown[] } };
    expect(att.type).toBe("template");
    expect(att.payload.template_type).toBe("button");
    expect(att.payload.text).toBe("Choose:");
    expect(att.payload.buttons).toEqual([
      { type: "web_url", url: "https://example.com", title: "Visit" },
      { type: "postback", title: "Start", payload: "GO" },
    ]);
  });

  it("falls back postback payload to the button title when omitted", () => {
    const msg = buildMessageObject({ text: "t", buttons: [{ title: "Tap" }] }, FB);
    const att = msg.attachment as { payload: { buttons: Array<{ payload: string }> } };
    expect(att.payload.buttons[0].payload).toBe("Tap");
  });

  it("keeps quick replies alongside a button template", () => {
    const msg = buildMessageObject(
      {
        text: "t",
        buttons: [{ title: "Go", payload: "GO" }],
        quick_replies: [{ content_type: "text" as const, title: "Q", payload: "Q" }],
      },
      FB,
    );
    expect((msg.attachment as { payload: { template_type: string } }).payload.template_type).toBe("button");
    expect(msg.quick_replies).toEqual([{ content_type: "text", title: "Q", payload: "Q" }]);
  });

  it("ignores buttons when there is no text (template requires text)", () => {
    const msg = buildMessageObject({ buttons: [{ title: "Go", payload: "GO" }] }, FB);
    expect(msg.attachment).toBeUndefined();
    expect(msg.text).toBeUndefined();
  });
});

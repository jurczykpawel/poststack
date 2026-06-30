import { describe, it, expect } from "vitest";
import { normalizeOutgoingAttachments } from "./attachments";
import type { MessageContent } from "@/lib/platforms/base";

describe("normalizeOutgoingAttachments", () => {
  it("returns null for text-only content", () => {
    expect(normalizeOutgoingAttachments({ text: "hello" })).toBeNull();
  });

  it("returns null for empty content", () => {
    expect(normalizeOutgoingAttachments({})).toBeNull();
  });

  it("maps buttons to titles only (drops payload/url)", () => {
    const content: MessageContent = {
      text: "Claim it",
      buttons: [
        { title: "Open", url: "https://x" },
        { title: "Claim", payload: "CLAIM_LM" },
      ],
    };
    expect(normalizeOutgoingAttachments(content)).toEqual({
      buttons: [{ title: "Open" }, { title: "Claim" }],
    });
  });

  it("maps text quick_replies to titles, ignoring email/phone (titleless) ones", () => {
    const content: MessageContent = {
      quick_replies: [
        { content_type: "text", title: "Yes", payload: "Y" },
        { content_type: "text", title: "No", payload: "N" },
        { content_type: "user_email" },
      ],
    };
    expect(normalizeOutgoingAttachments(content)).toEqual({
      quick_replies: [{ title: "Yes" }, { title: "No" }],
    });
  });

  it("maps media attachments to type + url", () => {
    const content: MessageContent = {
      attachments: [{ type: "image", url: "https://cdn/x.jpg" }],
    };
    expect(normalizeOutgoingAttachments(content)).toEqual({
      media: [{ type: "image", url: "https://cdn/x.jpg" }],
    });
  });

  it("combines media + buttons + quick_replies, including only present keys", () => {
    const content: MessageContent = {
      text: "hi",
      attachments: [{ type: "video", url: "https://cdn/v.mp4" }],
      buttons: [{ title: "B1" }],
      quick_replies: [{ title: "Q1", payload: "q1" }],
    };
    expect(normalizeOutgoingAttachments(content)).toEqual({
      media: [{ type: "video", url: "https://cdn/v.mp4" }],
      buttons: [{ title: "B1" }],
      quick_replies: [{ title: "Q1" }],
    });
  });
});

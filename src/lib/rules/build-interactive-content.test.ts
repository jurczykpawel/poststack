import { describe, it, expect } from "vitest";
import { buildInteractiveContent } from "./response";

describe("buildInteractiveContent", () => {
  it("returns an empty object when no interactive fields are set", () => {
    expect(buildInteractiveContent({ text: "hi" })).toEqual({});
  });

  it("passes through quick_replies when present", () => {
    const qr = [{ content_type: "text", title: "Yes", payload: "Y" }];
    expect(buildInteractiveContent({ quick_replies: qr })).toEqual({ quick_replies: qr });
  });

  it("passes through buttons when present", () => {
    const buttons = [{ title: "Claim", payload: "CLAIM" }];
    expect(buildInteractiveContent({ buttons })).toEqual({ buttons });
  });

  it("passes through both quick_replies and buttons", () => {
    const qr = [{ content_type: "user_email" }];
    const buttons = [{ title: "Go", url: "https://x" }];
    expect(buildInteractiveContent({ quick_replies: qr, buttons })).toEqual({ quick_replies: qr, buttons });
  });

  it("omits empty arrays", () => {
    expect(buildInteractiveContent({ quick_replies: [], buttons: [] })).toEqual({});
  });

  it("ignores non-array values defensively", () => {
    expect(buildInteractiveContent({ quick_replies: "nope", buttons: 5 })).toEqual({});
  });
});

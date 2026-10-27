import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import type { CreatorInfoResult } from "@/lib/providers/tiktok-creator-info";

interface Panel {
  mode: string; privacy: string; allowComment: boolean; allowDuet: boolean; allowStitch: boolean;
  disclosure: boolean; brandYourBrand: boolean; brandedContent: boolean; consent: boolean; videoDurationSec: number;
  readonly valid: boolean; readonly unavailable: boolean; readonly durationExceeded: boolean;
  readonly disclosureLabel: string; readonly brandedContentDisabled: boolean;
  readonly privacyOptionsView: Array<{ value: string; label: string; disabled: boolean; note: string }>;
  options(): Record<string, unknown>; onBrandedContentChange(): void;
  interactionDisabled(kind: string): boolean; interactionNote(kind: string): string;
}
const result: CreatorInfoResult = { status: "available", creator_info: {
  creator_nickname: "Creator", creator_avatar_url: "", privacy_level_options: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"],
  comment_disabled: true, duet_disabled: false, stitch_disabled: true, max_video_post_duration_sec: 60,
} };
const window = {} as { psTikTokPanel: (result?: CreatorInfoResult, channelId?: string) => Panel };
runInNewContext(readFileSync("src/server/ui/static/tiktok-panel.js", "utf8"), { window });
const ready = () => { const c = window.psTikTokPanel(result, "channel"); c.mode = "direct"; c.privacy = "PUBLIC_TO_EVERYONE"; return c; };

describe("TikTok creator-facing choices", () => {
  it("starts with inbox, no privacy, unchecked interactions, disclosure and consent", () => {
    const c = window.psTikTokPanel(result);
    expect([c.mode, c.privacy, c.allowComment, c.allowDuet, c.allowStitch, c.disclosure, c.consent]).toEqual(["inbox", "", false, false, false, false, false]);
  });
  it("requires an explicit creator-listed privacy choice for Direct Post", () => {
    const c = ready(); c.privacy = ""; expect(c.valid).toBe(false);
    c.privacy = "FOLLOWER_OF_CREATOR"; expect(c.valid).toBe(false);
    c.privacy = "SELF_ONLY"; expect(c.valid).toBe(true);
  });
  it.each(["comment", "stitch"])("disables %s and explains why", (kind) => {
    const c = ready(); expect(c.interactionDisabled(kind)).toBe(true);
    expect(c.interactionNote(kind)).toContain("TikTok account settings");
  });
  it("preserves optional interactions but forces creator-disabled interactions off", () => {
    const c = ready(); c.allowComment = c.allowDuet = c.allowStitch = true;
    expect(c.options()).toMatchObject({ tiktokDisableComment: true, tiktokDisableDuet: false, tiktokDisableStitch: true });
  });
  it("requires a disclosure selection only when disclosure is on", () => {
    const c = ready(); expect(c.valid).toBe(true);
    c.disclosure = true; expect(c.valid).toBe(false);
    c.brandYourBrand = true; expect(c.valid).toBe(true);
  });
  it.each([[true, false, "Promotional content"], [false, true, "Paid partnership"], [true, true, "Paid partnership"]] as const)("labels disclosure %s/%s", (own, branded, label) => {
    const c = ready(); c.disclosure = true; c.brandYourBrand = own; c.brandedContent = branded;
    expect(c.disclosureLabel).toBe(label);
  });
  it("disables Only me with the required explanation for branded content", () => {
    const c = ready(); c.disclosure = c.brandedContent = true;
    expect(c.privacyOptionsView.find((o) => o.value === "SELF_ONLY")).toMatchObject({ disabled: true, note: "Branded content visibility cannot be set to private" });
    c.privacy = "SELF_ONLY"; expect(c.valid).toBe(false); expect(c.brandedContentDisabled).toBe(true);
    c.onBrandedContentChange(); expect(c.privacy).toBe("");
  });
  it("omits commercial flags after disclosure is turned off", () => {
    const c = ready(); c.brandYourBrand = c.brandedContent = true; c.disclosure = false;
    expect(c.disclosureLabel).toBe("");
    expect(c.options()).toMatchObject({ tiktokBrandContentToggle: false, tiktokBrandOrganicToggle: false });
  });
  it("blocks Direct Post when creator info is unavailable", () => {
    const c = window.psTikTokPanel({ status: "cannot_post_now", reason: "reached_active_user_cap", message: "Try again later" });
    c.mode = "direct"; expect(c.unavailable).toBe(true); expect(c.valid).toBe(false);
  });
  it("checks video duration against creator limits", () => {
    const c = ready(); c.videoDurationSec = 61;
    expect(c.durationExceeded).toBe(true); expect(c.valid).toBe(false);
    c.videoDurationSec = 60; expect(c.valid).toBe(true);
  });
  it("keeps creator options in the creator-provided order", () => {
    expect(ready().privacyOptionsView.map((o) => o.value)).toEqual(result.creator_info.privacy_level_options);
  });
});

import { describe, it, expect } from "vitest";
import { channelMatchesPlatform } from "./platform-match";

const ch = (platform: string) => ({ platform, metadata: {} });

describe("channelMatchesPlatform [PSA44] (RS facebook/instagram model)", () => {
  it("facebook + instagram are distinct channel platforms, matched exactly", () => {
    expect(channelMatchesPlatform("instagram", ch("instagram"))).toBe(true);
    expect(channelMatchesPlatform("instagram", ch("facebook"))).toBe(false);
    expect(channelMatchesPlatform("facebook", ch("facebook"))).toBe(true);
    expect(channelMatchesPlatform("facebook", ch("instagram"))).toBe(false);
    expect(channelMatchesPlatform("instagram", ch("youtube"))).toBe(false);
  });

  it("editorial 'x' maps to the channel platform 'twitter'", () => {
    expect(channelMatchesPlatform("x", ch("twitter"))).toBe(true);
    expect(channelMatchesPlatform("x", ch("youtube"))).toBe(false);
  });

  it("other platforms must match the channel platform exactly", () => {
    expect(channelMatchesPlatform("youtube", ch("youtube"))).toBe(true);
    expect(channelMatchesPlatform("youtube", ch("tiktok"))).toBe(false);
    expect(channelMatchesPlatform("tiktok", ch("tiktok"))).toBe(true);
    expect(channelMatchesPlatform("threads", ch("threads"))).toBe(true);
    expect(channelMatchesPlatform("linkedin", ch("linkedin"))).toBe(true);
  });
});

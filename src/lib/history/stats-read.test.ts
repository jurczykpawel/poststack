import { describe, it, expect } from "vitest";
import { mergeWebhookStatusCounts, mergeWebhookPlatformCounts } from "./stats-read";

describe("mergeWebhookStatusCounts", () => {
  it("adds live + stat counts per status", () => {
    const out = mergeWebhookStatusCounts(
      [{ status: "fired", n: 3 }, { status: "recorded", n: 5 }],
      [{ handling_status: "fired", count: 10 }, { handling_status: "no_match", count: 2 }],
    );
    expect(out).toEqual({ fired: 13, recorded: 5, no_match: 2 });
  });
  it("handles empty inputs", () => {
    expect(mergeWebhookStatusCounts([], [])).toEqual({});
  });
});

describe("mergeWebhookPlatformCounts", () => {
  it("adds live + stat counts per platform", () => {
    const out = mergeWebhookPlatformCounts(
      [{ platform: "instagram", n: 3 }, { platform: "facebook", n: 5 }],
      [{ platform: "instagram", count: 10 }, { platform: "facebook", count: 2 }],
    );
    expect(out).toEqual({ instagram: 13, facebook: 7 });
  });
  it("drops null-platform rows (unresolved page→channel) from the breakdown", () => {
    const out = mergeWebhookPlatformCounts(
      [{ platform: null, n: 4 }, { platform: "facebook", n: 1 }],
      [{ platform: null, count: 9 }, { platform: "facebook", count: 2 }],
    );
    expect(out).toEqual({ facebook: 3 });
  });
  it("handles empty inputs", () => {
    expect(mergeWebhookPlatformCounts([], [])).toEqual({});
  });
});

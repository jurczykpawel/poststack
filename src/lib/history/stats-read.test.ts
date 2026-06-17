import { describe, it, expect } from "vitest";
import { mergeWebhookStatusCounts, mergePostReactionTotals } from "./stats-read";

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

describe("mergePostReactionTotals", () => {
  const d = (s: string) => new Date(s);
  it("sums counts per type and takes the latest lastAt", () => {
    const out = mergePostReactionTotals(
      [{ postId: "p1", channelId: "c1", type: "like", n: 2, lastAt: d("2026-01-02") }],
      [{ post_id: "p1", channel_id: "c1", reaction_type: "like", count: 5, last_reacted_at: d("2026-01-01") },
       { post_id: "p1", channel_id: "c1", reaction_type: "love", count: 1, last_reacted_at: d("2026-03-01") }],
    );
    const p1 = out.get("p1")!;
    expect(p1.channelId).toBe("c1");
    expect(p1.total).toBe(8);
    expect(p1.types.get("like")).toBe(7);
    expect(p1.types.get("love")).toBe(1);
    expect(p1.lastAt).toEqual(d("2026-03-01"));
  });
  it("works with only stats (post fully compacted)", () => {
    const out = mergePostReactionTotals(
      [],
      [{ post_id: "p9", channel_id: "c1", reaction_type: "like", count: 4, last_reacted_at: d("2026-02-02") }],
    );
    expect(out.get("p9")!.total).toBe(4);
  });
});

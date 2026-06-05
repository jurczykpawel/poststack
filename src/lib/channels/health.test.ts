import { describe, it, expect, beforeEach, vi } from "vitest";

const mockUpdate = vi.fn().mockResolvedValue({});
vi.mock("@/lib/prisma", () => ({
  prisma: { channel: { update: (...a: unknown[]) => mockUpdate(...a) } },
}));

import { markChannelNeedsReauth, markChannelHealthy } from "./health";

describe("markChannelNeedsReauth", () => {
  beforeEach(() => vi.clearAllMocks());

  it("flags the channel needs_reauth with the error and a health timestamp", async () => {
    const now = new Date("2026-06-05T12:00:00.000Z");
    await markChannelNeedsReauth("ch-1", "token dead", now);
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "ch-1" },
      data: { status: "needs_reauth", last_error: "token dead", last_health_at: now },
    });
  });

  it("truncates overly long error messages", async () => {
    await markChannelNeedsReauth("ch-1", "x".repeat(1000));
    expect((mockUpdate.mock.calls[0][0].data.last_error as string).length).toBe(500);
  });
});

describe("markChannelHealthy", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sets the channel active and clears the last error", async () => {
    const now = new Date("2026-06-05T12:00:00.000Z");
    await markChannelHealthy("ch-1", now);
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "ch-1" },
      data: { status: "active", last_error: null, last_health_at: now },
    });
  });
});

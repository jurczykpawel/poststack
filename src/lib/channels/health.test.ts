import { describe, it, expect, beforeEach, vi } from "vitest";

const mockFindUnique = vi.fn();
const mockUpdate = vi.fn().mockResolvedValue({});
vi.mock("@/lib/prisma", () => ({
  prisma: {
    channel: {
      findUnique: (...a: unknown[]) => mockFindUnique(...a),
      update: (...a: unknown[]) => mockUpdate(...a),
    },
  },
}));

const mockNotify = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/notifications/channel-alert", () => ({
  notifyChannelDown: (...a: unknown[]) => mockNotify(...a),
}));

import { markChannelNeedsReauth, markChannelHealthy } from "./health";

const activeRow = { status: "active", workspace_id: "ws-1", platform: "instagram", display_name: "My IG" };

describe("markChannelNeedsReauth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindUnique.mockResolvedValue(activeRow);
  });

  it("flags needs_reauth with the error and a health timestamp", async () => {
    const now = new Date("2026-06-05T12:00:00.000Z");
    await markChannelNeedsReauth("ch-1", "token dead", now);
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "ch-1" },
      data: { status: "needs_reauth", last_error: "token dead", last_health_at: now },
    });
  });

  it("notifies exactly once on the ok→down transition", async () => {
    mockFindUnique.mockResolvedValueOnce({ ...activeRow, status: "active" });
    await markChannelNeedsReauth("ch-1", "token dead");
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify.mock.calls[0][0]).toMatchObject({
      workspaceId: "ws-1",
      channelId: "ch-1",
      platform: "instagram",
      reason: "token dead",
    });
  });

  it("does NOT notify when the channel is already needs_reauth (no alert storm)", async () => {
    mockFindUnique.mockResolvedValueOnce({ ...activeRow, status: "needs_reauth" });
    await markChannelNeedsReauth("ch-1", "token dead again");
    expect(mockUpdate).toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("does nothing for a missing channel", async () => {
    mockFindUnique.mockResolvedValueOnce(null);
    await markChannelNeedsReauth("ch-x", "x");
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
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
